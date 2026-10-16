// Invite a friend (docs/tz-v2-circle.md §11; Felix §19 #6).
//
// The friend's joining fee is lower by the invitation discount (default $10:
// first invoice $40) through a once-only Stripe coupon on the joining-fee
// product. The member gets the reward (default 10 credits) when the friend's
// second invoice is paid (first invoice + first renewal). One credited
// invitation per member per UTC quarter of the friend's join. Before Checkout:
// the member is active, the friend is new (no membership, no legacy Stripe
// record, no other Stripe customer with that email) and is not the member.
// At the second payment: the season, then a card fingerprint or shipping
// address shared with the member → manual review (Felix), then rule 3. A
// refund or dispute on either of the friend's first two charges voids the
// invitation, or reverses the reward once credited. The discount is offered
// only while rule 3 holds on current data (fail closed).

import { HttpError, badRequest, conflict, forbidden, notFound } from "../http/errors.js";
import { stripeRequest } from "../stripe/client.js";
import { resolvePrices } from "../stripe/catalog.js";
import { loadSettings, economicsBasis } from "./economics-store.js";
import { referralCheck } from "./economics.js";
import { ledgerEntry } from "./ledger.js";
import { emailUser } from "./notify.js";
import { portalUrl } from "../routes/auth.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function seasonOf(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function newCode(randomBytes) {
  const bytes = (randomBytes || ((n) => crypto.getRandomValues(new Uint8Array(n))))(8);
  return [...bytes].map((b) => ALPHABET[b & 31]).join("");
}

async function memberStatus(env, userId) {
  const m = await env.DB.prepare(
    "SELECT status FROM memberships WHERE user_id = ?1 AND status IN ('pending','active','past_due','canceling') ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first();
  return m ? m.status : null;
}

// Rule 3 on current data with the current amounts.
async function ruleThree(env) {
  const { settings } = await loadSettings(env);
  const b = await economicsBasis(env, settings);
  const check = referralCheck({ D: settings.referral_discount_cents, R: settings.referral_reward_cents, W: b.W, s: b.ship, kPpm: b.kPpm }, settings);
  return { settings, check };
}

// ---- the member's side ---------------------------------------------------------

export async function getInvite(ctx) {
  const { env, session } = ctx;
  if ((await memberStatus(env, session.user.id)) !== "active") throw forbidden("members_only", "Invitations are for active members.");
  let row = await env.DB.prepare("SELECT code FROM referral_codes WHERE user_id = ?1").bind(session.user.id).first();
  if (!row) {
    for (let i = 0; i < 5 && !row; i++) {
      const code = newCode(ctx.randomBytes);
      await env.DB.prepare("INSERT OR IGNORE INTO referral_codes (code, user_id, created_at) VALUES (?1, ?2, ?3)").bind(code, session.user.id, ctx.nowIso()).run();
      row = await env.DB.prepare("SELECT code FROM referral_codes WHERE user_id = ?1").bind(session.user.id).first();
    }
  }
  const season = seasonOf(ctx.nowIso());
  const mine = (await env.DB.prepare("SELECT status FROM referrals WHERE referrer_user_id = ?1 AND season = ?2").bind(session.user.id, season).all()).results;
  const thisSeason = mine.some((r) => r.status === "credited") ? "counted"
    : mine.some((r) => ["joined", "qualifying", "review"].includes(r.status)) ? "joined" : "none";
  const { settings, check } = await ruleThree(env);
  return ctx.json({
    code: row.code, link: `${portalUrl(env)}/circle/join?invite=${row.code}`,
    discount_cents: settings.referral_discount_cents, reward_cents: settings.referral_reward_cents,
    season, this_season: thisSeason, paused: !check.ok,
  });
}

// ---- before Checkout ------------------------------------------------------------

async function evaluate(ctx, friend, code) {
  const { env } = ctx;
  if (typeof code !== "string" || !CODE_RE.test(code)) return { ok: false, note: null };
  const c = await env.DB.prepare("SELECT * FROM referral_codes WHERE code = ?1 AND disabled_at IS NULL").bind(code).first();
  if (!c) return { ok: false, note: null };
  if ((await memberStatus(env, c.user_id)) !== "active") return { ok: false, note: null };
  const NEW_ONLY = "This invitation is for new members.";
  const referrer = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?1").bind(c.user_id).first();
  if (!referrer || referrer.id === friend.id || referrer.email.toLowerCase() === String(friend.email).toLowerCase()) return { ok: false, note: NEW_ONLY };
  const past = await env.DB.prepare("SELECT 1 AS yes FROM memberships WHERE user_id = ?1 LIMIT 1").bind(friend.id).first();
  if (past) return { ok: false, note: NEW_ONLY };
  const legacy = await env.DB.prepare("SELECT 1 AS yes FROM legacy_users WHERE email = ?1 AND stripe_customer_id IS NOT NULL LIMIT 1")
    .bind(String(friend.email).toLowerCase()).first();
  if (legacy) return { ok: false, note: NEW_ONLY };
  const prior = await env.DB.prepare("SELECT status FROM referrals WHERE friend_user_id = ?1").bind(friend.id).first();
  if (prior && !["pending_checkout", "expired"].includes(prior.status)) return { ok: false, note: NEW_ONLY };
  const { settings, check } = await ruleThree(env);
  if (!check.ok) return { ok: false, note: null };
  // No Stripe customer with this email other than the friend's own.
  const own = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?1").bind(friend.id).first();
  const quoted = String(friend.email).replace(/'/g, "\\'");
  const found = await stripeRequest(env, ctx.fetch, "GET", "/v1/customers/search", { query: `email:'${quoted}'`, limit: 10 });
  if ((found.data || []).some((cu) => cu.id !== (own && own.stripe_customer_id))) return { ok: false, note: NEW_ONLY };
  return { ok: true, code: c, settings };
}

export async function describeInvitation(ctx, friend, code) {
  try {
    const e = await evaluate(ctx, friend, code);
    if (!e.ok) return { invitation: null, note: e.note };
    const d = e.settings.referral_discount_cents;
    return { invitation: { discount_cents: d }, note: `Your invitation takes $${d % 100 === 0 ? d / 100 : (d / 100).toFixed(2)} off the joining fee.` };
  } catch (err) {
    console.error("invitation check failed", err && (err.code || err.message));
    return { invitation: null, note: null };
  }
}

async function couponFor(ctx, amount) {
  const { env } = ctx;
  const prices = await resolvePrices(env, ctx.fetch, ctx.now());
  const product = prices.joining.product;
  const hit = await env.DB.prepare("SELECT coupon_id FROM referral_coupons WHERE amount_cents = ?1 AND product_id = ?2").bind(amount, product).first();
  if (hit) return hit.coupon_id;
  const c = await stripeRequest(env, ctx.fetch, "POST", "/v1/coupons", {
    amount_off: amount, currency: "usd", duration: "once", applies_to: { products: [product] }, name: "Circle invitation",
  }, { idempotencyKey: `circle-coupon:${amount}:${product}` });
  await env.DB.prepare("INSERT OR IGNORE INTO referral_coupons (amount_cents, product_id, coupon_id, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(amount, product, c.id, ctx.nowIso()).run();
  return c.id;
}

// For POST /api/circle/checkout: null = join at full price.
export async function invitationForCheckout(ctx, friend, code) {
  const e = await evaluate(ctx, friend, code).catch((err) => {
    console.error("invitation check failed", err && (err.code || err.message));
    return { ok: false };
  });
  if (!e.ok) return null;
  const { env } = ctx;
  const D = e.settings.referral_discount_cents;
  const R = e.settings.referral_reward_cents;
  const coupon = await couponFor(ctx, D);
  const nowIso = ctx.nowIso();
  const id = ctx.newId();
  await env.DB.prepare(
    `INSERT INTO referrals (id, code, referrer_user_id, friend_user_id, status, coupon_id, discount_cents, reward_cents, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'pending_checkout', ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(friend_user_id) DO UPDATE SET code = ?2, referrer_user_id = ?3, status = 'pending_checkout', coupon_id = ?5,
       discount_cents = ?6, reward_cents = ?7, updated_at = ?8
     WHERE referrals.status IN ('pending_checkout','expired')`
  ).bind(id, e.code.code, e.code.user_id, friend.id, coupon, D, R, nowIso).run();
  const row = await env.DB.prepare("SELECT id FROM referrals WHERE friend_user_id = ?1 AND status = 'pending_checkout'").bind(friend.id).first();
  if (!row) return null;
  return { referral_id: row.id, coupon_id: coupon, discount_cents: D };
}

// ---- after Checkout (Stripe hooks) ------------------------------------------------

export async function onSessionCompleted(svc, { session, membership }) {
  const rid = session.metadata && session.metadata.referral_id;
  if (!rid) return;
  await svc.env.DB.prepare(
    `UPDATE referrals SET status = 'joined', season = ?1, checkout_session_id = ?2, subscription_id = ?3, updated_at = ?4
      WHERE id = ?5 AND friend_user_id = ?6 AND status IN ('pending_checkout','expired')`
  ).bind(seasonOf(svc.nowIso()), session.id, session.subscription, svc.nowIso(), rid, membership.user_id).run();
}

export async function onSessionExpired(svc, { session }) {
  const rid = session.metadata && session.metadata.referral_id;
  if (!rid) return;
  await svc.env.DB.prepare("UPDATE referrals SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status = 'pending_checkout'")
    .bind(svc.nowIso(), rid).run();
}

function addressKey(json) {
  if (!json) return null;
  try {
    const a = JSON.parse(json).address || {};
    if (!a.line1 || !a.postal_code) return null;
    return `${String(a.line1).trim().toLowerCase()}|${String(a.postal_code).trim()}`;
  } catch {
    return null;
  }
}

async function matchSignals(env, r) {
  const reasons = [];
  const fp = async (userId) => (await env.DB.prepare("SELECT card_fingerprint FROM stripe_payments WHERE user_id = ?1").bind(userId).all())
    .results.map((p) => p.card_fingerprint);
  const friendFps = await fp(r.friend_user_id);
  const memberFps = (await fp(r.referrer_user_id)).filter(Boolean);
  if (friendFps.length === 0 || friendFps.some((x) => !x)) reasons.push("card fingerprint missing");
  else if (friendFps.some((x) => memberFps.includes(x))) reasons.push("card matches the member's");
  const addr = async (userId) => (await env.DB.prepare("SELECT shipping_json FROM gift_selections WHERE user_id = ?1").bind(userId).all())
    .results.map((g) => addressKey(g.shipping_json)).filter(Boolean);
  const fa = await addr(r.friend_user_id);
  const ma = await addr(r.referrer_user_id);
  if (fa.some((x) => ma.includes(x))) reasons.push("same shipping address as the member");
  return reasons;
}

// Credits the member, or records why not. decision 'admin' skips the match check.
export async function settle(svc, r, { skipMatch = false } = {}) {
  const { env } = svc;
  const nowIso = svc.nowIso();
  const set = (status, reason = null) => env.DB.prepare(
    "UPDATE referrals SET status = ?1, reason = ?2, updated_at = ?3 WHERE id = ?4 AND status IN ('qualifying','review')"
  ).bind(status, reason, nowIso, r.id).run();
  const used = await env.DB.prepare("SELECT 1 AS yes FROM referrals WHERE referrer_user_id = ?1 AND season = ?2 AND status = 'credited' AND id <> ?3")
    .bind(r.referrer_user_id, r.season, r.id).first();
  if (used) return set("not_counted_season", "one counted invitation per season");
  if (!skipMatch) {
    const reasons = await matchSignals(env, r);
    if (reasons.length) return set("review", reasons.join("; "));
  }
  const { check } = await ruleThree(env);
  if (!check.ok) return set("not_counted_economics", check.reason);
  if ((await memberStatus(env, r.referrer_user_id)) === null) return set("void", "the member's membership has ended");
  const friend = await env.DB.prepare("SELECT first_name FROM users WHERE id = ?1").bind(r.friend_user_id).first();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE referrals SET status = 'credited', reason = NULL, credited_at = ?1, updated_at = ?1 WHERE id = ?2 AND status IN ('qualifying','review')")
        .bind(nowIso, r.id),
      ledgerEntry(env, { id: svc.newId(), userId: r.referrer_user_id, amountCents: r.reward_cents, kind: "referral", ref: r.id,
        memo: `Referral — ${(friend && friend.first_name) || "a friend"}`, key: `referral:${r.id}`, createdAt: nowIso }),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return set("not_counted_season", "one counted invitation per season");
    throw e;
  }
  svc.waitUntil(emailUser(svc, r.referrer_user_id, "referral_credited", `referral_credited:${r.id}`, { rewardCents: r.reward_cents }));
}

export async function onInvoicePaid(svc, { membership }) {
  const { env } = svc;
  const r = await env.DB.prepare(
    "SELECT * FROM referrals WHERE friend_user_id = ?1 AND subscription_id = ?2 AND status IN ('joined','qualifying')"
  ).bind(membership.user_id, membership.stripe_subscription_id).first();
  if (!r) return;
  const m = await env.DB.prepare("SELECT paid_invoices FROM memberships WHERE id = ?1").bind(membership.id).first();
  const paid = m ? m.paid_invoices : 0;
  await env.DB.prepare("UPDATE referrals SET friend_paid_invoices = ?1, status = 'qualifying', updated_at = ?2 WHERE id = ?3")
    .bind(paid, svc.nowIso(), r.id).run();
  if (paid >= 2) await settle(svc, { ...r, status: "qualifying" });
}

async function undo(svc, invoiceId, why) {
  const { env } = svc;
  const inv = await env.DB.prepare(
    `SELECT i.invoice_id, m.user_id, m.stripe_subscription_id FROM membership_invoices i JOIN memberships m ON m.id = i.membership_id
      WHERE i.invoice_id = ?1`
  ).bind(invoiceId).first();
  if (!inv) return;
  const r = await env.DB.prepare("SELECT * FROM referrals WHERE friend_user_id = ?1 AND subscription_id = ?2").bind(inv.user_id, inv.stripe_subscription_id).first();
  if (!r) return;
  // Only the friend's first two invoices matter.
  const firstTwo = (await env.DB.prepare(
    `SELECT invoice_id FROM membership_invoices i JOIN memberships m ON m.id = i.membership_id
      WHERE m.stripe_subscription_id = ?1 ORDER BY i.period_start LIMIT 2`
  ).bind(inv.stripe_subscription_id).all()).results.map((x) => x.invoice_id);
  if (!firstTwo.includes(invoiceId)) return;
  const nowIso = svc.nowIso();
  if (r.status === "credited") {
    await env.DB.batch([
      env.DB.prepare("UPDATE referrals SET status = 'reversed', reason = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'credited'").bind(why, nowIso, r.id),
      ledgerEntry(env, { id: svc.newId(), userId: r.referrer_user_id, amountCents: -r.reward_cents, kind: "referral_reversal", ref: r.id,
        memo: "Reversed — referral", key: `referral_reversal:${r.id}`, createdAt: nowIso }),
    ]);
  } else if (["joined", "qualifying", "review", "pending_checkout"].includes(r.status)) {
    await env.DB.prepare("UPDATE referrals SET status = 'void', reason = ?1, updated_at = ?2 WHERE id = ?3").bind(why, nowIso, r.id).run();
  }
}

export const onChargeRefunded = (svc, { payment }) => undo(svc, payment.invoice_id, "refund");
export const onDispute = (svc, { payment, opened }) => (opened && payment ? undo(svc, payment.invoice_id, "dispute") : null);

export async function onSubscriptionEnded(svc, { membership }) {
  await svc.env.DB.prepare(
    "UPDATE referrals SET status = 'lapsed', updated_at = ?1 WHERE friend_user_id = ?2 AND subscription_id = ?3 AND status IN ('joined','qualifying')"
  ).bind(svc.nowIso(), membership.user_id, membership.stripe_subscription_id).run();
}

// ---- admin ------------------------------------------------------------------------------

export async function listInvitations(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT r.id, r.status, r.reason, r.season, r.discount_cents, r.reward_cents, r.friend_paid_invoices, r.created_at, r.credited_at,
            m.email AS member_email, f.email AS friend_email
       FROM referrals r JOIN users m ON m.id = r.referrer_user_id JOIN users f ON f.id = r.friend_user_id
      ORDER BY r.created_at DESC LIMIT 200`
  ).all();
  return ctx.json({ invitations: results, review: results.filter((r) => r.status === "review") });
}

export async function decideInvitation(ctx) {
  const { env, params } = ctx;
  const body = await (await import("../http/body.js")).readJson(ctx.request);
  if (!["credit", "reject"].includes(body.decision)) throw badRequest("invalid_decision", "Decide credit or reject.");
  const r = await env.DB.prepare("SELECT * FROM referrals WHERE id = ?1").bind(params.id).first();
  if (!r) throw notFound();
  if (r.status !== "review") throw conflict("not_in_review", "This invitation is not waiting for review.");
  if (body.decision === "reject") {
    await env.DB.prepare("UPDATE referrals SET status = 'rejected', updated_at = ?1 WHERE id = ?2 AND status = 'review'").bind(ctx.nowIso(), r.id).run();
  } else {
    await settle(ctx, r, { skipMatch: true });
  }
  await env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, 'invitation_decided', ?3, ?4, ?5)"
  ).bind(ctx.newId(), ctx.admin.email, r.id, JSON.stringify({ decision: body.decision }), ctx.nowIso()).run();
  const after = await env.DB.prepare("SELECT status, reason FROM referrals WHERE id = ?1").bind(r.id).first();
  return ctx.json(after);
}

export { HttpError };
