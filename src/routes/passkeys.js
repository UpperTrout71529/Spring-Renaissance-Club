// Passkeys (spec §8.2, §10.3; task S4): register, sign in without an email,
// list, remove (step-up). Public keys are stored as base64url text — D1 and
// the test emulation agree on text, while BLOB round-trips differ by runtime.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { badRequest, conflict, notFound, tooManyRequests } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { base64url } from "../lib/crypto.js";
import { withinLimit } from "../lib/rate-limit.js";
import { recordEvent } from "../lib/events.js";
import { createSession, summarizeUserAgent } from "../auth/session.js";
import { requireStepUp } from "../auth/step-up.js";
import { MAX_PASSKEYS, RP_NAME, challengeOf, claimChallenge, parseTransports, rpConfig, storeChallenge } from "../auth/webauthn.js";

const MINUTE = 60 * 1000;
const PASSKEY_IP_LIMIT = { bucket: "auth_passkey_ip", limit: 30, windowMs: MINUTE };

const invalidPasskey = () => badRequest("passkey_invalid", "We couldn't verify this passkey. Please try again.");
const challengeExpired = () => badRequest("challenge_expired", "This request has expired. Please try again.");

function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP") || "").split(",")[0].trim() || "unknown";
}

async function limitIp(ctx) {
  if (!(await withinLimit(ctx.env, { ...PASSKEY_IP_LIMIT, subject: clientIp(ctx.request), nowMs: ctx.now() }))) {
    throw tooManyRequests();
  }
}

// The WebAuthn user handle: the user's ULID as bytes. Never the email.
const userHandle = (userId) => new TextEncoder().encode(userId);

function publicPasskey(row) {
  return {
    credential_id: row.credential_id,
    device_label: row.device_label,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    backed_up: !!row.backed_up,
  };
}

async function countPasskeys(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?1").bind(userId).first();
  return Number(row && row.n) || 0;
}

// POST /api/auth/passkey/register/options (session)
export async function registerOptions(ctx) {
  const { env, session, json } = ctx;
  const { user } = session;
  const existing = await env.DB.prepare("SELECT credential_id, transports FROM passkeys WHERE user_id = ?1")
    .bind(user.id).all();
  if (existing.results.length >= MAX_PASSKEYS) {
    throw conflict("passkey_limit", `You can keep up to ${MAX_PASSKEYS} passkeys. Remove one to add another.`);
  }
  const { rpID } = rpConfig(env);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userID: userHandle(user.id),
    userDisplayName: user.first_name || user.email,
    attestationType: "none",
    excludeCredentials: existing.results.map((r) => ({ id: r.credential_id, transports: parseTransports(r.transports) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    timeout: 60000,
  });
  await storeChallenge(env, { challenge: options.challenge, purpose: "register", userId: user.id, nowMs: ctx.now() });
  return json(options);
}

// POST /api/auth/passkey/register/verify { response, device_label? } (session) → 201
export async function registerVerify(ctx) {
  const { env, session, json, request } = ctx;
  const { user } = session;
  const body = await readJson(request);
  const response = body.response;
  if (!response || typeof response !== "object") throw invalidPasskey();

  const challenge = challengeOf(response);
  if (!(await claimChallenge(env, { challenge, purpose: "register", userId: user.id, nowIso: ctx.nowIso() }))) {
    throw challengeExpired();
  }
  const { rpID, origins } = rpConfig(env);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    throw invalidPasskey();
  }
  if (!verification.verified) throw invalidPasskey();
  if ((await countPasskeys(env, user.id)) >= MAX_PASSKEYS) {
    throw conflict("passkey_limit", `You can keep up to ${MAX_PASSKEYS} passkeys. Remove one to add another.`);
  }

  const info = verification.registrationInfo;
  const label = typeof body.device_label === "string" && body.device_label.trim()
    ? body.device_label.trim().slice(0, 64)
    : summarizeUserAgent(request.headers.get("User-Agent"));
  const row = {
    credential_id: info.credential.id,
    device_label: label || null,
    created_at: ctx.nowIso(),
    last_used_at: null,
    backed_up: info.credentialBackedUp ? 1 : 0,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO passkeys (credential_id, user_id, public_key, sign_count, transports, aaguid,
                             device_label, backed_up, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      row.credential_id, user.id, isoBase64URL.fromBuffer(info.credential.publicKey), info.credential.counter,
      JSON.stringify(info.credential.transports || []), info.aaguid, row.device_label, row.backed_up, row.created_at
    ).run();
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY/i.test(String(e && e.message))) {
      throw conflict("passkey_exists", "This passkey is already saved.");
    }
    throw e;
  }
  await recordEvent(env, { id: ctx.newId(), userId: user.id, name: "passkey_added", createdAt: ctx.nowIso() });
  return json({ passkey: publicPasskey(row) }, 201);
}

// POST /api/auth/passkey/login/options { email? } → options for a
// discoverable credential. The email is accepted and ignored: answering with
// that address's credentials would tell anyone which emails have passkeys.
export async function loginOptions(ctx) {
  await limitIp(ctx);
  const { rpID } = rpConfig(ctx.env);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required", timeout: 60000 });
  await storeChallenge(ctx.env, { challenge: options.challenge, purpose: "login", nowMs: ctx.now() });
  return ctx.json(options);
}

// Verifies an assertion against a stored passkey and bumps its counter.
// Returns the passkey row (with user_id) or throws passkey_invalid.
async function verifyAssertion(ctx, { response, challenge, userId = null }) {
  const { env } = ctx;
  if (typeof response.id !== "string") throw invalidPasskey();
  const row = await env.DB.prepare(
    `SELECT p.credential_id, p.user_id, p.public_key, p.sign_count, p.transports
       FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.credential_id = ?1 AND u.deleted_at IS NULL`
  ).bind(response.id).first();
  if (!row || (userId && row.user_id !== userId)) throw invalidPasskey();

  // A discoverable credential names its user; it must be this passkey's user.
  const handle = response.response && response.response.userHandle;
  if (handle && handle !== base64url(userHandle(row.user_id))) throw invalidPasskey();

  const { rpID, origins } = rpConfig(env);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: {
        id: row.credential_id,
        publicKey: isoBase64URL.toBuffer(row.public_key),
        counter: row.sign_count,
        transports: parseTransports(row.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    throw invalidPasskey();
  }
  if (!verification.verified) throw invalidPasskey();

  await env.DB.prepare(
    "UPDATE passkeys SET sign_count = ?1, last_used_at = ?2, backed_up = ?3 WHERE credential_id = ?4"
  ).bind(verification.authenticationInfo.newCounter, ctx.nowIso(),
    verification.authenticationInfo.credentialBackedUp ? 1 : 0, row.credential_id).run();
  return row;
}

// POST /api/auth/passkey/login/verify { response } → 200 { user } + cookie.
export async function loginVerify(ctx) {
  await limitIp(ctx);
  const { env, request, json } = ctx;
  const body = await readJson(request);
  const response = body.response;
  if (!response || typeof response !== "object") throw invalidPasskey();
  const challenge = challengeOf(response);
  if (!(await claimChallenge(env, { challenge, purpose: "login", nowIso: ctx.nowIso() }))) throw challengeExpired();

  const passkey = await verifyAssertion(ctx, { response, challenge });
  const nowIso = ctx.nowIso();
  await env.DB.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(nowIso, passkey.user_id).run();
  const user = await env.DB.prepare("SELECT id, email, first_name, tier FROM users WHERE id = ?1")
    .bind(passkey.user_id).first();

  const { cookie } = await createSession(env, {
    userId: user.id,
    authMethod: "passkey",
    nowMs: ctx.now(),
    uaSummary: summarizeUserAgent(request.headers.get("User-Agent")),
    geoCity: request.cf && typeof request.cf.city === "string" ? request.cf.city : null,
    randomBytes: ctx.randomBytes,
  });
  ctx.setCookie(cookie);
  await recordEvent(env, {
    id: ctx.newId(), userId: user.id, name: "login_succeeded",
    props: { method: "passkey", is_first: false }, createdAt: nowIso,
  });
  return json({ user: { id: user.id, email: user.email, first_name: user.first_name, tier: user.tier } });
}

// GET /api/passkeys (session) — for Account → Sign-in & security (§6.8).
export async function listPasskeys(ctx) {
  const rows = await ctx.env.DB.prepare(
    `SELECT credential_id, device_label, created_at, last_used_at, backed_up
       FROM passkeys WHERE user_id = ?1 ORDER BY created_at`
  ).bind(ctx.session.user.id).all();
  return ctx.json({ passkeys: rows.results.map(publicPasskey) });
}

// DELETE /api/passkeys/:credential_id (session + step-up) → 204.
export async function deletePasskey(ctx) {
  requireStepUp(ctx);
  const res = await ctx.env.DB.prepare("DELETE FROM passkeys WHERE credential_id = ?1 AND user_id = ?2")
    .bind(ctx.params.credential_id, ctx.session.user.id).run();
  if (!res.meta || res.meta.changes !== 1) throw notFound();
  return new Response(null, { status: 204 });
}

// ---- step-up with a passkey ------------------------------------------------

// POST /api/auth/step-up/passkey/options (session) → options limited to this
// user's passkeys, with a challenge bound to this session.
export async function stepUpPasskeyOptions(ctx) {
  const { env, session, json } = ctx;
  const rows = await env.DB.prepare("SELECT credential_id, transports FROM passkeys WHERE user_id = ?1")
    .bind(session.user.id).all();
  if (!rows.results.length) throw conflict("no_passkeys", "There is no passkey on this account. We can email you a code instead.");
  const { rpID } = rpConfig(env);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    timeout: 60000,
    allowCredentials: rows.results.map((r) => ({ id: r.credential_id, transports: parseTransports(r.transports) })),
  });
  await storeChallenge(env, {
    challenge: options.challenge, purpose: "step_up", userId: session.user.id, sessionIdHash: session.idHash, nowMs: ctx.now(),
  });
  return json(options);
}

export async function verifyStepUpPasskey(ctx, response) {
  if (!response || typeof response !== "object") throw invalidPasskey();
  const challenge = challengeOf(response);
  const ok = await claimChallenge(ctx.env, {
    challenge, purpose: "step_up", userId: ctx.session.user.id, sessionIdHash: ctx.session.idHash, nowIso: ctx.nowIso(),
  });
  if (!ok) throw challengeExpired();
  await verifyAssertion(ctx, { response, challenge, userId: ctx.session.user.id });
}
