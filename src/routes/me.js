// GET /api/me and PATCH /api/me (spec §8.3). Club: membership null, no badge.
// V2: { status, kind } of the current membership, and the Circle tab dot
// (§5.4) when something waits: a sealed piece to choose, an unread reply from
// the Maison, a payment problem, an anniversary address.

import { badRequest } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { recordEvent } from "../lib/events.js";
import { sha256Hex } from "../lib/crypto.js";
import { shopifyConfigured, updateCustomer } from "../shopify/admin.js";

// The exact words next to the seasonal-email switch in Account → Emails
// (portal copy.account.seasonalLabel). Consents store a hash of what the
// person saw (§7 consents.shown_text_sha256); a test keeps the two in sync.
export const SEASONAL_EMAIL_TEXT = "Send me the seasonal letter — one email each season. You can turn it off at any time.";
export const SEASONAL_EMAIL_VERSION = "seasonal-email-2026-10";

async function membershipSummary(env, userId) {
  const m = await env.DB.prepare(
    `SELECT status, kind FROM memberships WHERE user_id = ?1
      ORDER BY CASE WHEN status IN ('active','past_due','canceling') THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
  ).bind(userId).first();
  return m ? { status: m.status, kind: m.kind } : null;
}

async function circleDot(env, userId) {
  const row = await env.DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM memberships WHERE user_id = ?1 AND status = 'past_due') OR
       EXISTS (SELECT 1 FROM gift_selections s JOIN memberships m ON m.id = s.membership_id
                WHERE s.user_id = ?1 AND s.status = 'awaiting_choice' AND m.status IN ('active','past_due','canceling')) OR
       EXISTS (SELECT 1 FROM anniversary_gifts WHERE user_id = ?1 AND status = 'awaiting_address') OR
       EXISTS (SELECT 1 FROM concierge_messages c JOIN concierge_threads t ON t.id = c.thread_id
                WHERE t.user_id = ?1 AND c.author = 'maison' AND c.read_at IS NULL) AS dot`
  ).bind(userId).first();
  return !!(row && row.dot);
}

export async function getMe({ env, session, json }) {
  const { user } = session;
  const row = await env.DB.prepare(
    `SELECT u.first_name, u.last_name, u.created_at, u.onboarding_dismissed_at, u.seasonal_email_opt_in,
            EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1) AS passkey,
            EXISTS (SELECT 1 FROM wishlist_items WHERE user_id = ?1) AS saved
       FROM users u WHERE u.id = ?1`
  ).bind(user.id).first();

  return json({
    user: {
      id: user.id, email: user.email, first_name: row.first_name, last_name: row.last_name,
      tier: user.tier, created_at: row.created_at, seasonal_email_opt_in: !!row.seasonal_email_opt_in,
    },
    membership: await membershipSummary(env, user.id),
    badges: { circle: await circleDot(env, user.id) },
    onboarding: { passkey: !!row.passkey, saved: !!row.saved, dismissed: !!row.onboarding_dismissed_at },
  });
}

const NAME_MAX = 80;

// A name: trimmed, ≤ 80 characters, no control characters; empty → null.
function readName(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (v.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v || null;
}

// PATCH /api/me: { first_name?, last_name?, seasonal_email_opt_in?,
// onboarding_dismissed: true?, circle_teaser_snooze: true? }. Unknown fields
// and wrong types are refused, not ignored.
const FIELDS = new Set(["first_name", "last_name", "seasonal_email_opt_in", "onboarding_dismissed", "circle_teaser_snooze"]);
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export async function patchMe(ctx) {
  const body = await readJson(ctx.request);
  const keys = Object.keys(body);
  const invalid = () => badRequest("invalid_fields", "Some of these fields can't be changed here.");
  if (!keys.length || keys.some((k) => !FIELDS.has(k))) throw invalid();

  const names = {};
  for (const k of ["first_name", "last_name"]) {
    if (k in body) {
      const v = readName(body[k]);
      if (v === undefined) throw badRequest("invalid_name", `Please keep names under ${NAME_MAX} characters.`);
      names[k] = v;
    }
  }
  if ("seasonal_email_opt_in" in body && typeof body.seasonal_email_opt_in !== "boolean") throw invalid();
  for (const k of ["onboarding_dismissed", "circle_teaser_snooze"]) {
    if (k in body && body[k] !== true) throw invalid();
  }

  const { env, session } = ctx;
  const nowIso = ctx.nowIso();
  const stmts = [];
  if ("first_name" in names) stmts.push(env.DB.prepare("UPDATE users SET first_name = ?1 WHERE id = ?2").bind(names.first_name, session.user.id));
  if ("last_name" in names) stmts.push(env.DB.prepare("UPDATE users SET last_name = ?1 WHERE id = ?2").bind(names.last_name, session.user.id));
  if (body.onboarding_dismissed) {
    stmts.push(env.DB.prepare("UPDATE users SET onboarding_dismissed_at = COALESCE(onboarding_dismissed_at, ?1) WHERE id = ?2")
      .bind(nowIso, session.user.id));
  }
  if (body.circle_teaser_snooze) {
    stmts.push(env.DB.prepare("UPDATE users SET circle_teaser_snoozed_until = ?1 WHERE id = ?2")
      .bind(new Date(ctx.now() + SNOOZE_MS).toISOString(), session.user.id));
  }
  if ("seasonal_email_opt_in" in body) {
    // §7: every grant or withdrawal is a consent row with the text's hash.
    stmts.push(env.DB.prepare("UPDATE users SET seasonal_email_opt_in = ?1 WHERE id = ?2")
      .bind(body.seasonal_email_opt_in ? 1 : 0, session.user.id));
    stmts.push(env.DB.prepare(
      `INSERT INTO consents (id, user_id, kind, document_version, shown_text_sha256, granted, ua_summary, created_at)
       VALUES (?1, ?2, 'seasonal_email', ?3, ?4, ?5, NULL, ?6)`
    ).bind(ctx.newId(), session.user.id, SEASONAL_EMAIL_VERSION, await sha256Hex(SEASONAL_EMAIL_TEXT),
      body.seasonal_email_opt_in ? 1 : 0, nowIso));
  }
  await env.DB.batch(stmts);

  if (body.circle_teaser_snooze) {
    await recordEvent(env, {
      id: ctx.newId(), userId: session.user.id, name: "circle_teaser_snoozed",
      props: { placement: "home" }, createdAt: nowIso,
    });
  }

  // §8.3: the name is mirrored to the Shopify customer, after the response.
  if (("first_name" in names || "last_name" in names) && shopifyConfigured(env)) {
    const row = await env.DB.prepare("SELECT shopify_customer_id, first_name, last_name FROM users WHERE id = ?1")
      .bind(session.user.id).first();
    if (row && row.shopify_customer_id) {
      ctx.waitUntil(updateCustomer(env, ctx.fetch, row.shopify_customer_id, {
        firstName: row.first_name || "", lastName: row.last_name || "",
      }).catch((e) => console.error("shopify name sync failed", e && e.message)));
    }
  }
  return getMe(ctx);
}
