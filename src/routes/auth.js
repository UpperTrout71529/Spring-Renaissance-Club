// Sign-in by email link and sign-out (spec §8.2, §10.1, §10.6; task S2).

import { HttpError, badRequest, tooManyRequests } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { randomToken, sha256Hex, TOKEN_RE } from "../lib/crypto.js";
import { isPlausibleEmail, maskEmail, normalizeEmail } from "../lib/email-address.js";
import { withinLimit } from "../lib/rate-limit.js";
import { recordEvent } from "../lib/events.js";
import { verifyTurnstile } from "../auth/turnstile.js";
import { clearedSessionCookie, createSession, revokeSession, summarizeUserAgent } from "../auth/session.js";
import { sendEmail } from "../email/send.js";
import { signInLinkEmail } from "../email/templates/sign-in-link.js";
import { customerTags, findOrCreateClubCustomer, shopifyConfigured } from "../shopify/admin.js";
import { importReserveHolds } from "../shopify/reserve-import.js";
import { syncWaitlistTag } from "./circle.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const MAGIC_LINK_TTL_MS = 15 * MINUTE;

// §10.6
export const LIMITS = {
  linkPerIp: { bucket: "auth_link_ip", limit: 20, windowMs: HOUR },
  linkPerEmailShort: { bucket: "auth_link_email_10m", limit: 3, windowMs: 10 * MINUTE },
  linkPerEmailDay: { bucket: "auth_link_email_day", limit: 10, windowMs: DAY },
  verifyPerIp: { bucket: "auth_verify_ip", limit: 10, windowMs: MINUTE },
};

const DEFAULT_PORTAL_URL = "https://club.springrenaissance.store";
const STOREFRONT_ORIGIN = "https://springrenaissance.store";

export function portalUrl(env) {
  return (env.PORTAL_URL || DEFAULT_PORTAL_URL).replace(/\/+$/, "");
}

function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP") || "").split(",")[0].trim() || "unknown";
}

// §10.1: a relative portal path or a storefront URL; anything else is dropped.
export function sanitizeReturnTo(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  if (/^\/(?![/\\])[^\s\\]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin === STOREFRONT_ORIGIN && !url.username && !url.password) return url.href;
  } catch {
    // not a URL
  }
  return null;
}

async function limit(env, rule, subject, nowMs) {
  if (!(await withinLimit(env, { ...rule, subject, nowMs }))) throw tooManyRequests();
}

// POST /api/auth/magic-link { email, turnstile_token, return_to? } → 202.
// The answer is the same for a known and an unknown address: every
// well-formed address gets a link, because the same link creates the account.
export async function requestMagicLink(ctx) {
  const { env, request, json } = ctx;
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!isPlausibleEmail(email)) {
    throw badRequest("invalid_email", "Please enter a valid email address.");
  }

  const nowMs = ctx.now();
  await limit(env, LIMITS.linkPerIp, clientIp(request), nowMs);
  if (!(await verifyTurnstile(env, ctx.fetch, body.turnstile_token))) {
    throw badRequest("turnstile_failed", "We couldn't verify this request. Please try again.");
  }
  await limit(env, LIMITS.linkPerEmailShort, email, nowMs);
  await limit(env, LIMITS.linkPerEmailDay, email, nowMs);

  const nowIso = ctx.nowIso();
  const token = randomToken(ctx.randomBytes);
  const tokenHash = await sha256Hex(token);
  await env.DB.batch([
    // Housekeeping rides the index on expires_at; a day of slack keeps
    // just-expired rows around for the 410 answer.
    env.DB.prepare("DELETE FROM magic_links WHERE expires_at < ?1")
      .bind(new Date(nowMs - DAY).toISOString()),
    env.DB.prepare(
      `INSERT INTO magic_links (token_hash, email, return_to, purpose, expires_at, created_at)
       VALUES (?1, ?2, ?3, 'sign_in', ?4, ?5)`
    ).bind(tokenHash, email, sanitizeReturnTo(body.return_to), new Date(nowMs + MAGIC_LINK_TTL_MS).toISOString(), nowIso),
  ]);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?1 AND deleted_at IS NULL")
    .bind(email).first();
  const userId = existing ? existing.id : null;

  // The token travels in the #fragment: it never reaches server logs, and a
  // mail scanner that follows the link cannot spend it (§16.3 №23).
  const link = `${portalUrl(env)}/auth#t=${token}`;
  ctx.waitUntil(sendEmail({
    env,
    fetchImpl: ctx.fetch,
    id: ctx.newId(),
    userId,
    template: "sign_in_link",
    dedupeKey: `sign_in_link:${tokenHash}`,
    message: signInLinkEmail({ to: email, link, portalUrl: portalUrl(env) }),
    nowIso,
  }));
  await recordEvent(env, { id: ctx.newId(), userId, name: "login_requested", props: { method: "magic_link" }, createdAt: nowIso });

  return json({ ok: true }, 202);
}

const linkExpired = () => new HttpError(
  410, "link_expired", "Sign-in links work once and for 15 minutes. We can send a fresh one."
);

// POST /api/auth/verify { token } → 200 { user, return_to } + Set-Cookie,
// or 410 link_expired for an unknown, used or expired token.
export async function verifyMagicLink(ctx) {
  const { env, request, json } = ctx;
  const nowMs = ctx.now();
  await limit(env, LIMITS.verifyPerIp, clientIp(request), nowMs);

  const body = await readJson(request);
  const token = body.token;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw linkExpired();

  const nowIso = ctx.nowIso();
  const tokenHash = await sha256Hex(token);
  // The guarded UPDATE is the one-time check: of two concurrent verifies
  // exactly one sees changes = 1.
  const spent = await env.DB.prepare(
    `UPDATE magic_links SET used_at = ?1
      WHERE token_hash = ?2 AND purpose = 'sign_in' AND used_at IS NULL AND expires_at > ?1`
  ).bind(nowIso, tokenHash).run();
  if (!spent.meta || spent.meta.changes !== 1) throw linkExpired();

  const link = await env.DB.prepare("SELECT email, return_to FROM magic_links WHERE token_hash = ?1")
    .bind(tokenHash).first();

  const newUserId = ctx.newId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, email_verified_at, created_at)
       VALUES (?1, ?2, ?3, ?3)`
    ).bind(newUserId, link.email, nowIso),
    env.DB.prepare(
      `UPDATE users SET last_login_at = ?1, email_verified_at = COALESCE(email_verified_at, ?1)
        WHERE email = ?2 AND deleted_at IS NULL`
    ).bind(nowIso, link.email),
  ]);
  const user = await env.DB.prepare(
    `SELECT id, email, first_name, tier, shopify_customer_id FROM users
      WHERE email = ?1 AND deleted_at IS NULL`
  ).bind(link.email).first();
  if (!user) throw new Error("verify: no live user after upsert");
  const isFirst = user.id === newUserId;

  const { cookie } = await createSession(env, {
    userId: user.id,
    authMethod: "magic_link",
    nowMs,
    uaSummary: summarizeUserAgent(request.headers.get("User-Agent")),
    geoCity: request.cf && typeof request.cf.city === "string" ? request.cf.city : null,
    randomBytes: ctx.randomBytes,
  });
  ctx.setCookie(cookie);

  await recordEvent(env, {
    id: ctx.newId(), userId: user.id, name: "login_succeeded",
    props: { method: "magic_link", is_first: isFirst }, createdAt: nowIso,
  });
  afterSignIn(ctx, { user, isFirst, nowIso });

  return json({
    user: { id: user.id, email: user.email, first_name: user.first_name, tier: user.tier },
    return_to: link.return_to || null,
  });
}

// Background work after any sign-in (link or passkey): link the Shopify
// customer if needed, and bring reservations made through the storefront's
// "Let us hold these for you" (customer tags) into Held for you.
export function afterSignIn(ctx, { user, isFirst, nowIso }) {
  if (isFirst || !user.shopify_customer_id) {
    ctx.waitUntil(linkShopifyCustomer(ctx, { userId: user.id, email: user.email, isFirst, nowIso }));
  } else if (shopifyConfigured(ctx.env)) {
    ctx.waitUntil((async () => {
      try {
        const tags = await customerTags(ctx.env, ctx.fetch, user.shopify_customer_id);
        await importReserveHolds({ env: ctx.env, fetchImpl: ctx.fetch, newId: ctx.newId, nowIso }, user.id, tags);
        await syncWaitlistTag(ctx.env, ctx.fetch, user.id, user.shopify_customer_id, tags);
      } catch (e) {
        console.error("reserve import failed", e && e.message);
      }
    })());
  }
}

// §9.2.2. Runs after the response; a failure leaves shopify_customer_id NULL
// and the next sign-in tries again.
async function linkShopifyCustomer(ctx, { userId, email, isFirst, nowIso }) {
  const { env } = ctx;
  let hadOrders = null;
  try {
    if (!shopifyConfigured(env)) {
      console.error("shopify not configured — customer not linked");
    } else {
      const customer = await findOrCreateClubCustomer(env, ctx.fetch, email);
      hadOrders = customer.hadOrders;
      await env.DB.prepare(
        "UPDATE users SET shopify_customer_id = ?1 WHERE id = ?2 AND shopify_customer_id IS NULL"
      ).bind(customer.id, userId).run();
      await importReserveHolds({ env, fetchImpl: ctx.fetch, newId: ctx.newId, nowIso }, userId, customer.tags);
      await syncWaitlistTag(env, ctx.fetch, userId, customer.id, customer.tags);
    }
  } catch (e) {
    console.error("shopify link failed", e && e.message, maskEmail(email));
  }
  if (isFirst) {
    await recordEvent(env, {
      id: ctx.newId(), userId, name: "account_created",
      props: { had_shopify_orders: hadOrders }, createdAt: nowIso,
    });
  }
}

// POST /api/auth/logout → 204, cookie cleared, session revoked if there was one.
export async function logout(ctx) {
  if (ctx.session) await revokeSession(ctx.env, ctx.session.idHash, ctx.nowIso());
  ctx.setCookie(clearedSessionCookie());
  return new Response(null, { status: 204 });
}
