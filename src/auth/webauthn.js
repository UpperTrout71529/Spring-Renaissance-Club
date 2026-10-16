// WebAuthn plumbing shared by passkey sign-in, registration and step-up
// (spec §10.3): relying-party config and one-time challenges in D1.

import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";

export const RP_NAME = "Spring Renaissance";
const DEFAULT_RP_ID = "springrenaissance.store";
const DEFAULT_ORIGINS = ["https://club.springrenaissance.store"];
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS = 10;

// rpID is the registrable domain, so a key made on club. also works on the
// storefront if it is ever needed there. PASSKEY_RP_ID / PASSKEY_ORIGINS
// override both for local development and e2e.
export function rpConfig(env) {
  const origins = typeof env.PASSKEY_ORIGINS === "string"
    ? env.PASSKEY_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    rpID: env.PASSKEY_RP_ID || DEFAULT_RP_ID,
    origins: origins.length ? origins : DEFAULT_ORIGINS,
  };
}

export async function storeChallenge(env, { challenge, purpose, userId = null, sessionIdHash = null, nowMs }) {
  const now = new Date(nowMs).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?1")
      .bind(new Date(nowMs - 60 * 60 * 1000).toISOString()),
    env.DB.prepare(
      `INSERT INTO webauthn_challenges (challenge, purpose, user_id, session_id_hash, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(challenge, purpose, userId, sessionIdHash, new Date(nowMs + CHALLENGE_TTL_MS).toISOString(), now),
  ]);
}

// The challenge the browser signed, read from clientDataJSON — or null.
export function challengeOf(response) {
  try {
    const challenge = decodeClientDataJSON(response.response.clientDataJSON).challenge;
    return typeof challenge === "string" && challenge ? challenge : null;
  } catch {
    return null;
  }
}

// Spends a challenge exactly once; it must match the purpose and, where set,
// the user and session it was issued to.
export async function claimChallenge(env, { challenge, purpose, userId = null, sessionIdHash = null, nowIso }) {
  if (!challenge) return false;
  const res = await env.DB.prepare(
    `UPDATE webauthn_challenges SET used_at = ?1
      WHERE challenge = ?2 AND purpose = ?3 AND used_at IS NULL AND expires_at > ?1
        AND IFNULL(user_id, '') = IFNULL(?4, '')
        AND IFNULL(session_id_hash, '') = IFNULL(?5, '')`
  ).bind(nowIso, challenge, purpose, userId, sessionIdHash).run();
  return !!(res.meta && res.meta.changes === 1);
}

export function parseTransports(value) {
  try {
    const t = JSON.parse(value || "[]");
    return Array.isArray(t) ? t.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
