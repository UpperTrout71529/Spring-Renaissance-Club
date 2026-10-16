// Account and privacy (spec §8.2, §8.3, §10.4, §13.3–13.4; task S9): email
// change, sessions, data export, account deletion (Club: no Stripe part).

import { HttpError, badRequest, conflict, notFound, tooManyRequests } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { randomToken, sha256Hex, TOKEN_RE } from "../lib/crypto.js";
import { isPlausibleEmail, normalizeEmail } from "../lib/email-address.js";
import { withinLimit } from "../lib/rate-limit.js";
import { requireStepUp } from "../auth/step-up.js";
import { clearedSessionCookie } from "../auth/session.js";
import { sendEmail } from "../email/send.js";
import {
  accountDeletedEmail, adminAccountDeletedEmail, emailChangeConfirmEmail, emailChangeNoticeEmail,
} from "../email/templates/account.js";
import { removeCustomerTags, shopifyConfigured, updateCustomer } from "../shopify/admin.js";
import { portalUrl } from "./auth.js";
import { WAITLIST_TAG } from "./circle.js";
import { closeCircleForDeletion } from "../circle/account-delete.js";
import { PAST_TAG, VIP_TAG } from "../circle/effects.js";

const HOUR = 60 * 60 * 1000;
const EMAIL_CHANGE_TTL_MS = HOUR;
const EMAIL_CHANGES_PER_HOUR = { bucket: "email_change_user", limit: 3, windowMs: HOUR };
const CONFIRM_PER_IP = { bucket: "email_change_confirm_ip", limit: 10, windowMs: 60 * 1000 };

const emailTaken = () => conflict("email_taken",
  "That email already has an account. Sign in with it, or write to the concierge to merge accounts.");

async function emailInUse(env, email) {
  const row = await env.DB.prepare("SELECT id FROM users WHERE email = ?1 AND deleted_at IS NULL").bind(email).first();
  return !!row;
}

function sendLater(ctx, { userId, template, to, message }) {
  const id = ctx.newId();
  ctx.waitUntil(sendEmail({
    env: ctx.env, fetchImpl: ctx.fetch, id, userId, template,
    dedupeKey: `${template}:${id}`, message, nowIso: ctx.nowIso(),
  }));
}

// POST /api/me/email-change { new_email } (session + step-up) → 202.
// A link goes to the new address; the old address is told about it.
export async function requestEmailChange(ctx) {
  requireStepUp(ctx);
  const { env, session, json } = ctx;
  const body = await readJson(ctx.request);
  const newEmail = normalizeEmail(body.new_email);
  if (!isPlausibleEmail(newEmail)) throw badRequest("invalid_email", "Please enter a valid email address.");
  if (newEmail === normalizeEmail(session.user.email)) {
    throw badRequest("same_email", "That is already the email on your account.");
  }
  if (await emailInUse(env, newEmail)) throw emailTaken();
  if (!(await withinLimit(env, { ...EMAIL_CHANGES_PER_HOUR, subject: session.user.id, nowMs: ctx.now() }))) {
    throw tooManyRequests();
  }

  const token = randomToken(ctx.randomBytes);
  await env.DB.prepare(
    `INSERT INTO magic_links (token_hash, email, return_to, purpose, expires_at, created_at, user_id)
     VALUES (?1, ?2, NULL, 'email_change', ?3, ?4, ?5)`
  ).bind(await sha256Hex(token), newEmail, new Date(ctx.now() + EMAIL_CHANGE_TTL_MS).toISOString(), ctx.nowIso(), session.user.id).run();

  const base = portalUrl(env);
  sendLater(ctx, {
    userId: session.user.id, template: "email_change_confirm", to: newEmail,
    message: emailChangeConfirmEmail({ to: newEmail, link: `${base}/account/email#t=${token}`, portalUrl: base }),
  });
  sendLater(ctx, {
    userId: session.user.id, template: "email_change_notice", to: session.user.email,
    message: emailChangeNoticeEmail({ to: session.user.email, newEmail, portalUrl: base }),
  });
  return json({ ok: true }, 202);
}

// POST /api/me/email-change/confirm { token } → 200 { email }. No session
// needed: the link proves the new address, and it was issued to an account
// after a step-up. 410 for an unknown, used or expired link.
export async function confirmEmailChange(ctx) {
  const { env, json } = ctx;
  const ip = (ctx.request.headers.get("CF-Connecting-IP") || "").split(",")[0].trim() || "unknown";
  if (!(await withinLimit(env, { ...CONFIRM_PER_IP, subject: ip, nowMs: ctx.now() }))) throw tooManyRequests();

  const body = await readJson(ctx.request);
  const gone = () => new HttpError(410, "link_expired", "This link has expired. You can ask for a new one in your account.");
  if (typeof body.token !== "string" || !TOKEN_RE.test(body.token)) throw gone();
  const nowIso = ctx.nowIso();
  const tokenHash = await sha256Hex(body.token);
  const spent = await env.DB.prepare(
    `UPDATE magic_links SET used_at = ?1
      WHERE token_hash = ?2 AND purpose = 'email_change' AND used_at IS NULL AND expires_at > ?1`
  ).bind(nowIso, tokenHash).run();
  if (!spent.meta || spent.meta.changes !== 1) throw gone();

  const link = await env.DB.prepare("SELECT email, user_id FROM magic_links WHERE token_hash = ?1").bind(tokenHash).first();
  const user = await env.DB.prepare("SELECT id, shopify_customer_id FROM users WHERE id = ?1 AND deleted_at IS NULL")
    .bind(link.user_id).first();
  if (!user) throw gone();
  if (await emailInUse(env, link.email)) throw emailTaken();
  try {
    await env.DB.prepare("UPDATE users SET email = ?1, email_verified_at = ?2 WHERE id = ?3")
      .bind(link.email, nowIso, user.id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw emailTaken();
    throw e;
  }
  if (user.shopify_customer_id && shopifyConfigured(env)) {
    ctx.waitUntil(updateCustomer(env, ctx.fetch, user.shopify_customer_id, { email: link.email })
      .catch((e) => console.error("shopify email sync failed", e && e.message)));
  }
  return json({ email: link.email });
}

// GET /api/sessions → { sessions: [{ id, current, auth_method, ua_summary,
// geo_city, created_at, last_seen_at }] } — live sessions only.
// The id a client sees for a session is derived from, but is not, the
// stored hash (the table's key): responses never carry database keys.
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
async function publicSessionId(idHash) {
  return (await sha256Hex(`session-id:${idHash}`)).slice(0, 32);
}

export async function listSessions(ctx) {
  const { env, session, json } = ctx;
  const nowIso = ctx.nowIso();
  const rows = (await env.DB.prepare(
    `SELECT id_hash, auth_method, ua_summary, geo_city, created_at, last_seen_at FROM sessions
      WHERE user_id = ?1 AND revoked_at IS NULL AND idle_expires_at > ?2 AND absolute_expires_at > ?2
      ORDER BY last_seen_at DESC`
  ).bind(session.user.id, nowIso).all()).results;
  return json({
    sessions: await Promise.all(rows.map(async (r) => ({
      id: await publicSessionId(r.id_hash), current: r.id_hash === session.idHash, auth_method: r.auth_method,
      ua_summary: r.ua_summary, geo_city: r.geo_city, created_at: r.created_at, last_seen_at: r.last_seen_at,
    }))),
  });
}

// DELETE /api/sessions/:id → 204 (one of my sessions; the current one also
// clears the cookie). 404 for anything else.
export async function revokeOneSession(ctx) {
  const { env, session, params } = ctx;
  if (!SESSION_ID_RE.test(params.id)) throw notFound();
  // Only this person's own sessions are candidates.
  const own = (await env.DB.prepare("SELECT id_hash FROM sessions WHERE user_id = ?1 AND revoked_at IS NULL")
    .bind(session.user.id).all()).results;
  let target = null;
  for (const r of own) if ((await publicSessionId(r.id_hash)) === params.id) target = r.id_hash;
  if (!target) throw notFound();
  const res = await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ?1 WHERE id_hash = ?2 AND user_id = ?3 AND revoked_at IS NULL"
  ).bind(ctx.nowIso(), target, session.user.id).run();
  if (!res.meta || res.meta.changes !== 1) throw notFound();
  if (target === session.idHash) ctx.setCookie(clearedSessionCookie());
  return new Response(null, { status: 204 });
}

// DELETE /api/sessions → 204: "Sign out everywhere" else (keeps this one).
export async function revokeOtherSessions(ctx) {
  await ctx.env.DB.prepare(
    "UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND id_hash <> ?3 AND revoked_at IS NULL"
  ).bind(ctx.nowIso(), ctx.session.user.id, ctx.session.idHash).run();
  return new Response(null, { status: 204 });
}

// GET /api/account/export (step-up) → a JSON file with everything the portal
// holds about the person (§13.3 for V1: profile, consents, saved pieces,
// holds, sign-in methods, sessions). Never key material or token hashes.
export async function exportAccount(ctx) {
  requireStepUp(ctx);
  const { env, session } = ctx;
  const id = session.user.id;
  const one = (sql) => env.DB.prepare(sql).bind(id).first();
  const all = async (sql) => (await env.DB.prepare(sql).bind(id).all()).results;

  const data = {
    exported_at: ctx.nowIso(),
    profile: await one(
      `SELECT email, first_name, last_name, tier, seasonal_email_opt_in, created_at, last_login_at,
              email_verified_at, shopify_customer_id IS NOT NULL AS shopify_linked
         FROM users WHERE id = ?1`),
    consents: await all("SELECT kind, document_version, granted, created_at FROM consents WHERE user_id = ?1 ORDER BY created_at"),
    saved: await all("SELECT product_handle, created_at FROM wishlist_items WHERE user_id = ?1 ORDER BY created_at"),
    holds: await all("SELECT kind, product_handle, source, status, created_at FROM holds WHERE user_id = ?1 ORDER BY created_at"),
    passkeys: await all("SELECT device_label, created_at, last_used_at, backed_up FROM passkeys WHERE user_id = ?1 ORDER BY created_at"),
    sessions: await all(
      "SELECT auth_method, ua_summary, geo_city, created_at, last_seen_at, revoked_at FROM sessions WHERE user_id = ?1 ORDER BY created_at"),
  };
  const day = ctx.nowIso().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="spring-renaissance-account-${day}.json"`,
    },
  });
}

// DELETE /api/account { confirm: "DELETE" } (step-up) → 202 (§13.4, Club):
// personal rows erased, the user row anonymised (orders and consents stay,
// with no personal data attached), every session signed out, an email to the
// original address, our Shopify tags removed and Felix told (data erasure in
// Shopify is his call — it cannot be undone).
export async function deleteAccount(ctx) {
  requireStepUp(ctx);
  const { env, session, json } = ctx;
  const body = await readJson(ctx.request);
  if (body.confirm !== "DELETE") throw badRequest("confirmation_required", "Please confirm that you want to delete your account.");

  const id = session.user.id;
  const user = await env.DB.prepare("SELECT email, shopify_customer_id FROM users WHERE id = ?1").bind(id).first();
  // V2: a live Circle membership is cancelled in Stripe first; if that fails
  // nothing below runs and the account stays (fail closed).
  const hadMembership = await closeCircleForDeletion(ctx, id);
  const nowIso = ctx.nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM step_up_codes WHERE session_id_hash IN (SELECT id_hash FROM sessions WHERE user_id = ?1)").bind(id),
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE user_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM passkeys WHERE user_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM oauth_identities WHERE user_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM wishlist_items WHERE user_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM holds WHERE user_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM magic_links WHERE user_id = ?1 OR email = ?2").bind(id, user.email),
    env.DB.prepare(
      `UPDATE users SET email = 'deleted+' || id || '@invalid', first_name = NULL, last_name = NULL,
              shopify_customer_id = NULL, stripe_customer_id = NULL, seasonal_email_opt_in = 0,
              circle_teaser_snoozed_until = NULL, onboarding_dismissed_at = NULL, deleted_at = ?1
        WHERE id = ?2`
    ).bind(nowIso, id),
  ]);
  ctx.setCookie(clearedSessionCookie());

  const base = portalUrl(env);
  sendLater(ctx, { userId: id, template: "account_deleted", to: user.email, message: accountDeletedEmail({ to: user.email, portalUrl: base }) });
  if (env.ADMIN_NOTIFY_EMAIL) {
    sendLater(ctx, {
      userId: id, template: "admin_account_deleted", to: env.ADMIN_NOTIFY_EMAIL,
      message: adminAccountDeletedEmail({ to: env.ADMIN_NOTIFY_EMAIL, userId: id, shopifyCustomerId: user.shopify_customer_id, portalUrl: base }),
    });
  } else {
    console.error("ADMIN_NOTIFY_EMAIL not set — account deletion notice not sent");
  }
  if (user.shopify_customer_id && shopifyConfigured(env)) {
    ctx.waitUntil(removeCustomerTags(env, ctx.fetch, user.shopify_customer_id,
      hadMembership ? ["sr-club", WAITLIST_TAG, VIP_TAG, PAST_TAG] : ["sr-club", WAITLIST_TAG])
      .catch((e) => console.error("shopify untag failed", e && e.message)));
  }
  return json({ deleted: true }, 202);
}
