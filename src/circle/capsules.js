// Seasonal capsules and Skip (spec v1.1 §8.4, §16.2, §16.3 #17; tz-v2 §9).
// Eligible: membership active or canceling (not past_due, §16.3 #8) with at
// least min_consecutive_months paid months, and no live Skip for the capsule.
// A claim turns min(balance, price) into a single-use card (§16.3 #17); the
// rest is paid at checkout. Skip is set or undone only before the window
// opens; it never touches billing or credits.

import { readJson } from "../http/body.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../http/errors.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { balanceCents } from "./ledger.js";
import { emailUser } from "./notify.js";
import { issueCard, reserveCredits } from "../routes/credits.js";
import { spendState } from "./spend.js";
import { requireStepUp } from "../auth/step-up.js";

const STORE = "https://springrenaissance.store";
const GID_PRODUCT = /^gid:\/\/shopify\/Product\/\d+$/;

async function membershipOf(env, userId) {
  return env.DB.prepare(
    "SELECT * FROM memberships WHERE user_id = ?1 AND status IN ('active','past_due','canceling') ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first();
}

async function productHandle(env, productGid) {
  const r = await env.DB.prepare("SELECT handle FROM catalog_variants WHERE product_gid = ?1 LIMIT 1").bind(productGid).first();
  return r ? r.handle : null;
}

async function skipOf(env, membershipId, capsuleId) {
  return env.DB.prepare("SELECT * FROM skips WHERE membership_id = ?1 AND capsule_id = ?2 AND canceled_at IS NULL").bind(membershipId, capsuleId).first();
}

function eligibility(m, cap, skipped) {
  if (!m || m.status === "past_due") return { eligible: false, reason: "Available to members whose membership is up to date." };
  if (skipped) return { eligible: false, reason: "You skipped this season's capsule." };
  if (m.consecutive_paid_months < cap.min_consecutive_months) {
    return { eligible: false, reason: cap.min_consecutive_months === 2 ? "Available after your second month" : `Available after ${cap.min_consecutive_months} paid months` };
  }
  return { eligible: true, reason: null };
}

export async function getCapsules(ctx) {
  const { env, session } = ctx;
  const m = await membershipOf(env, session.user.id);
  if (!m) throw forbidden("members_only", "Capsules are for members of the Circle.");
  const nowIso = ctx.nowIso();
  const { results } = await env.DB.prepare(
    "SELECT * FROM capsules WHERE status = 'scheduled' AND closes_at > ?1 ORDER BY opens_at"
  ).bind(nowIso).all();
  const shape = async (c) => {
    const skipped = !!(await skipOf(env, m.id, c.id));
    const claimed = !!(await env.DB.prepare("SELECT 1 AS yes FROM capsule_claims WHERE capsule_id = ?1 AND user_id = ?2 AND status IN ('issued','no_credits')").bind(c.id, session.user.id).first());
    const handle = await productHandle(env, c.shopify_product_gid);
    return {
      id: c.id, season: c.season, title: c.title, price_cents: c.price_cents, opens_at: c.opens_at, closes_at: c.closes_at,
      skipped, claimed, product_url: handle ? `${STORE}/products/${handle}` : null, ...eligibility(m, c, skipped),
    };
  };
  const current = results.find((c) => c.opens_at <= nowIso);
  const upcoming = results.filter((c) => c.opens_at > nowIso);
  return ctx.json({ current: current ? await shape(current) : null, upcoming: await Promise.all(upcoming.map(shape)) });
}

export async function claimCapsule(ctx) {
  const { env, session, params } = ctx;
  const userId = session.user.id;
  requireStepUp(ctx); // credits become a gift-card code (review finding 4)
  const cap = await env.DB.prepare("SELECT * FROM capsules WHERE id = ?1").bind(params.id).first();
  if (!cap) throw notFound();
  const nowIso = ctx.nowIso();
  if (cap.status !== "scheduled" || cap.opens_at > nowIso || cap.closes_at <= nowIso) throw conflict("capsule_closed", "This capsule is not open.");
  const m = await membershipOf(env, userId);
  const elig = eligibility(m, cap, m ? !!(await skipOf(env, m.id, cap.id)) : false);
  if (!elig.eligible) throw conflict("not_eligible", elig.reason);
  if (!shopifyConfigured(env)) throw new HttpError(503, "credits_unavailable", "We couldn't prepare your capsule just now. Please try again.");
  const claimId = ctx.newId();
  try {
    await env.DB.prepare("INSERT INTO capsule_claims (id, capsule_id, user_id, status, created_at) VALUES (?1, ?2, ?3, 'creating', ?4)")
      .bind(claimId, cap.id, userId, nowIso).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) {
      const prior = await env.DB.prepare("SELECT status FROM capsule_claims WHERE capsule_id = ?1 AND user_id = ?2").bind(cap.id, userId).first();
      if (prior && prior.status === "failed") {
        await env.DB.prepare("DELETE FROM capsule_claims WHERE capsule_id = ?1 AND user_id = ?2 AND status = 'failed'").bind(cap.id, userId).run();
        return claimCapsule(ctx);
      }
      throw conflict("already_claimed", "You have already claimed this capsule.");
    }
    throw e;
  }
  const handle = await productHandle(env, cap.shopify_product_gid);
  const productUrl = handle ? `${STORE}/products/${handle}` : null;
  const state = await spendState(env, userId, nowIso);
  const balance = state.ok ? Math.max(0, await balanceCents(env, userId)) : 0;
  const amount = Math.floor(Math.min(balance, cap.price_cents) / 100) * 100;
  if (amount < 100) {
    await env.DB.prepare("UPDATE capsule_claims SET status = 'no_credits' WHERE id = ?1").bind(claimId).run();
    return ctx.json({ capsule_id: cap.id, amount_cents: 0, code: null, product_url: productUrl }, 201);
  }
  const redemptionId = await reserveCredits(ctx, { userId, amount, purpose: "capsule", capsuleId: cap.id, memo: `${cap.season} capsule` });
  if (!redemptionId) {
    await env.DB.prepare("UPDATE capsule_claims SET status = 'failed' WHERE id = ?1").bind(claimId).run();
    throw conflict("insufficient_credits", "Your balance changed. Please try again.");
  }
  try {
    const card = await issueCard(ctx, { userId, redemptionId, amount, memoPrefix: `${cap.season} capsule` });
    await env.DB.prepare("UPDATE capsule_claims SET status = 'issued', redemption_id = ?1 WHERE id = ?2").bind(redemptionId, claimId).run();
    return ctx.json({ capsule_id: cap.id, amount_cents: amount, code: card.code, last4: card.last4, product_url: productUrl }, 201);
  } catch (e) {
    await env.DB.prepare("UPDATE capsule_claims SET status = 'failed', redemption_id = ?1 WHERE id = ?2").bind(redemptionId, claimId).run();
    throw e;
  }
}

// ---- Skip ------------------------------------------------------------------------

export async function listSkips(ctx) {
  const m = await membershipOf(ctx.env, ctx.session.user.id);
  if (!m) throw forbidden("members_only", "Skip is for members of the Circle.");
  const { results } = await ctx.env.DB.prepare(
    "SELECT s.capsule_id, c.season, c.opens_at FROM skips s JOIN capsules c ON c.id = s.capsule_id WHERE s.membership_id = ?1 AND s.canceled_at IS NULL"
  ).bind(m.id).all();
  return ctx.json({ skips: results });
}

async function skippable(ctx, capsuleId) {
  const m = await membershipOf(ctx.env, ctx.session.user.id);
  if (!m) throw forbidden("members_only", "Skip is for members of the Circle.");
  const cap = await ctx.env.DB.prepare("SELECT * FROM capsules WHERE id = ?1 AND status = 'scheduled'").bind(capsuleId).first();
  if (!cap) throw notFound();
  if (cap.opens_at <= ctx.nowIso()) throw conflict("capsule_window_open", "The capsule window has opened — you can simply not order it.");
  return { m, cap };
}

export async function postSkip(ctx) {
  const body = await readJson(ctx.request);
  if (typeof body.capsule_id !== "string") throw badRequest("invalid_request", "Which capsule?");
  const { m, cap } = await skippable(ctx, body.capsule_id);
  await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO skips (id, membership_id, capsule_id, created_at) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM skips WHERE membership_id = ?2 AND capsule_id = ?3 AND canceled_at IS NULL)"
  ).bind(ctx.newId(), m.id, cap.id, ctx.nowIso()).run();
  return ctx.json({ skipped: true }, 201);
}

export async function deleteSkip(ctx) {
  const { m, cap } = await skippable(ctx, ctx.params.capsule_id);
  await ctx.env.DB.prepare("UPDATE skips SET canceled_at = ?1 WHERE membership_id = ?2 AND capsule_id = ?3 AND canceled_at IS NULL")
    .bind(ctx.nowIso(), m.id, cap.id).run();
  return ctx.json({ skipped: false });
}

// ---- cron: tell eligible members the capsule is open (once) --------------------------

export async function announceCapsules(svc) {
  const { env } = svc;
  const nowIso = svc.nowIso();
  const caps = (await env.DB.prepare(
    "SELECT * FROM capsules WHERE status = 'scheduled' AND announced_at IS NULL AND opens_at <= ?1 AND closes_at > ?1"
  ).bind(nowIso).all()).results;
  let sent = 0;
  for (const cap of caps) {
    const members = (await env.DB.prepare(
      `SELECT m.id, m.user_id FROM memberships m
        WHERE m.status IN ('active','canceling') AND m.consecutive_paid_months >= ?1
          AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.membership_id = m.id AND s.capsule_id = ?2 AND s.canceled_at IS NULL)`
    ).bind(cap.min_consecutive_months, cap.id).all()).results;
    for (const m of members) {
      const r = await emailUser(svc, m.user_id, "capsule_open", `capsule_open:${cap.id}:${m.user_id}`,
        { season: cap.season, priceCents: cap.price_cents, closesOn: cap.closes_at.slice(0, 10) });
      if (r === "sent") sent++;
    }
    await env.DB.prepare("UPDATE capsules SET announced_at = ?1 WHERE id = ?2").bind(nowIso, cap.id).run();
  }
  return { capsules: caps.length, sent };
}

// ---- admin --------------------------------------------------------------------------------

async function audit(ctx, action, target, payload = null) {
  await ctx.env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(ctx.newId(), ctx.admin.email, action, target, payload ? JSON.stringify(payload) : null, ctx.nowIso()).run();
}

function normaliseCapsule(b, base = {}) {
  const c = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  for (const k of ["season", "title"]) {
    if (has(k)) {
      const v = typeof b[k] === "string" ? b[k].trim() : "";
      if (!v || v.length > 80) throw badRequest("invalid_text", `${k} is required (80 characters at most).`);
      c[k] = v;
    }
  }
  if (has("shopify_product_gid")) {
    if (!GID_PRODUCT.test(String(b.shopify_product_gid))) throw badRequest("invalid_product", "A Shopify product id.");
    c.shopify_product_gid = b.shopify_product_gid;
  }
  if (has("price_cents")) {
    if (!Number.isInteger(b.price_cents) || b.price_cents <= 0 || b.price_cents % 100 !== 0) throw badRequest("invalid_price", "A price in whole credits.");
    c.price_cents = b.price_cents;
  }
  if (has("min_consecutive_months")) {
    if (!Number.isInteger(b.min_consecutive_months) || b.min_consecutive_months < 1) throw badRequest("invalid_months", "At least one month.");
    c.min_consecutive_months = b.min_consecutive_months;
  }
  for (const k of ["opens_at", "closes_at"]) {
    if (has(k)) {
      if (typeof b[k] !== "string" || Number.isNaN(Date.parse(b[k]))) throw badRequest("invalid_date", `${k} must be a date.`);
      c[k] = new Date(b[k]).toISOString();
    }
  }
  for (const k of ["season", "title", "shopify_product_gid", "price_cents", "opens_at", "closes_at"]) {
    if (c[k] === undefined || c[k] === null) throw badRequest("missing_field", `${k} is required.`);
  }
  if (c.closes_at <= c.opens_at) throw badRequest("invalid_dates", "The window must close after it opens.");
  c.min_consecutive_months = c.min_consecutive_months || 2;
  return c;
}

async function assertCapsuleProduct(env, gid) {
  const any = await env.DB.prepare("SELECT COUNT(*) AS n FROM catalog_variants").first();
  if (any.n === 0) return;
  const row = await env.DB.prepare("SELECT product_tags FROM catalog_variants WHERE product_gid = ?1 LIMIT 1").bind(gid).first();
  let tags = [];
  try { tags = JSON.parse((row && row.product_tags) || "[]"); } catch { tags = []; }
  if (!row || !tags.includes("capsule")) throw badRequest("not_a_capsule_product", "Choose an existing Shopify product tagged capsule.");
}

export async function listCapsulesAdmin(ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM capsules ORDER BY opens_at DESC").all();
  return ctx.json({ capsules: results });
}

export async function createCapsule(ctx) {
  const c = normaliseCapsule(await readJson(ctx.request));
  await assertCapsuleProduct(ctx.env, c.shopify_product_gid);
  const id = ctx.newId();
  const nowIso = ctx.nowIso();
  await ctx.env.DB.prepare(
    `INSERT INTO capsules (id, season, title, shopify_product_gid, price_cents, min_consecutive_months, opens_at, closes_at, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'scheduled', ?9, ?9)`
  ).bind(id, c.season, c.title, c.shopify_product_gid, c.price_cents, c.min_consecutive_months, c.opens_at, c.closes_at, nowIso).run();
  await audit(ctx, "capsule_created", id, c);
  return ctx.json({ capsule: { id, ...c, status: "scheduled" } }, 201);
}

export async function patchCapsule(ctx) {
  const cap = await ctx.env.DB.prepare("SELECT * FROM capsules WHERE id = ?1").bind(ctx.params.id).first();
  if (!cap) throw notFound();
  const body = await readJson(ctx.request);
  const c = normaliseCapsule(body, cap);
  if (body.shopify_product_gid) await assertCapsuleProduct(ctx.env, c.shopify_product_gid);
  const status = body.status === "closed" ? "closed" : cap.status;
  await ctx.env.DB.prepare(
    `UPDATE capsules SET season = ?1, title = ?2, shopify_product_gid = ?3, price_cents = ?4, min_consecutive_months = ?5, opens_at = ?6,
       closes_at = ?7, status = ?8, updated_at = ?9 WHERE id = ?10`
  ).bind(c.season, c.title, c.shopify_product_gid, c.price_cents, c.min_consecutive_months, c.opens_at, c.closes_at, status, ctx.nowIso(), cap.id).run();
  await audit(ctx, "capsule_updated", cap.id, body);
  return ctx.json({ capsule: { ...cap, ...c, status } });
}
