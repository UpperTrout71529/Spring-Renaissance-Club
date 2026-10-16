// Economics data in D1 (docs/tz-v2-circle.md §4 0011, §12): versioned
// settings, costs per variant, Felix's Circle price list, the computed
// Circle price items, and the basis the rules need (cost per credit-dollar,
// the welcome piece cost). The formulas themselves are in economics.js.

import { badRequest } from "../http/errors.js";
import {
  DEFAULTS, SHIPPING_CLASSES, withSettings, checkVariant, circlePriceCents, costPerCreditPpm, referralCheck,
  anniversaryBudget, monthlyContribution, joiningNet, stripeNet, shippingFor,
} from "./economics.js";

const SETTING_KEYS = new Set(Object.keys(DEFAULTS));
const CENTS_KEYS = new Set(["monthly_cents", "joining_cents", "stripe_fixed_cents", "shopify_fixed_cents",
  "referral_discount_cents", "referral_reward_cents", "anniversary_cap_cents", "welcome_cap_cents"]);
const MAX_CENTS = 10000000;
export const MEMBERSHIP_HANDLE = "patron-membership";
export const OBJECT_TAG = "circle-object";

export async function loadSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value_json, version FROM economics_settings").all();
  const overrides = {};
  const versions = {};
  for (const r of results) {
    if (!SETTING_KEYS.has(r.key)) continue;
    overrides[r.key] = JSON.parse(r.value_json);
    versions[r.key] = r.version;
  }
  return { settings: withSettings(overrides), versions };
}

const isCents = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_CENTS;

// Validates a partial change set against the current settings; returns the
// merged settings and the keys that changed. Throws 400 on anything odd.
export function applyChanges(current, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw badRequest("invalid_changes", "Nothing to save.");
  const next = { ...current, shipping: { ...current.shipping } };
  const keys = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!SETTING_KEYS.has(key)) throw badRequest("unknown_setting", `Unknown setting ${key}.`);
    if (key === "shipping") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("invalid_shipping", "Shipping must be per class.");
      for (const [cls, row] of Object.entries(value)) {
        if (!SHIPPING_CLASSES.includes(cls)) throw badRequest("invalid_shipping", `Unknown shipping class ${cls}.`);
        if (!row || typeof row !== "object") throw badRequest("invalid_shipping", "Shipping must be { cents, estimate }.");
        const cents = row.cents === null ? null : row.cents;
        if (cents !== null && !isCents(cents)) throw badRequest("invalid_shipping", "Shipping must be whole cents.");
        if (typeof row.estimate !== "boolean") throw badRequest("invalid_shipping", "Say whether the figure is an estimate.");
        next.shipping[cls] = { cents, estimate: row.estimate };
      }
    } else if (key === "guard_profile") {
      if (!["expected", "worst"].includes(value)) throw badRequest("invalid_setting", "Profile is expected or worst.");
      next[key] = value;
    } else if (CENTS_KEYS.has(key)) {
      if (!isCents(value)) throw badRequest("invalid_setting", `${key} must be whole cents.`);
      next[key] = value;
    } else if (key.endsWith("_bps")) {
      if (!Number.isInteger(value) || value < 0 || value > 10000) throw badRequest("invalid_setting", `${key} must be 0–10000 bps.`);
      next[key] = value;
    } else {
      throw badRequest("unknown_setting", `Unknown setting ${key}.`);
    }
    keys.push(key);
  }
  if (next.referral_discount_cents > next.joining_cents) {
    throw badRequest("invalid_setting", "The invitation discount cannot exceed the joining fee.");
  }
  if (next.referral_reward_cents % 100 !== 0) throw badRequest("invalid_setting", "The reward is whole credits.");
  return { next, keys };
}

// ---- exclusions and the catalog view -----------------------------------------------

export function exclusionFor(row) {
  let tags = [];
  try { tags = JSON.parse(row.product_tags || "[]"); } catch { tags = []; }
  if (row.is_gift_card) return "gift_card";
  if (tags.includes("catalog")) return "catalog";
  if (tags.includes("capsule")) return "capsule";
  if (row.handle === MEMBERSHIP_HANDLE || tags.includes("membership")) return "membership";
  if (tags.includes(OBJECT_TAG) || row.is_object) return "members_object";
  return null;
}

async function catalogRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT c.*, k.cost_cents, k.zero_confirmed, k.shipping_class,
            CASE WHEN l.variant_gid IS NULL THEN 0 ELSE 1 END AS on_list
       FROM catalog_variants c
       LEFT JOIN variant_costs k ON k.variant_gid = c.variant_gid
       LEFT JOIN circle_price_list l ON l.variant_gid = c.variant_gid
      ORDER BY c.handle, c.variant_gid`
  ).all();
  const objects = await memberObjectVariants(env);
  return results.map((r) => ({ ...r, is_object: objects.has(r.variant_gid) }));
}

// Variants that are a members' object (T15 table, if present).
async function memberObjectVariants(env) {
  try {
    const { results } = await env.DB.prepare("SELECT variant_gid FROM member_object_releases WHERE kind = 'members_object'").all();
    return new Set(results.map((r) => r.variant_gid));
  } catch {
    return new Set();
  }
}

const evaluate = (r, s) => checkVariant({
  priceCents: r.price_cents, costCents: r.cost_cents === undefined ? null : r.cost_cents,
  shippingClass: r.shipping_class || null, onList: !!r.on_list, exclusion: exclusionFor(r),
}, s);

// Recomputes circle_price_items for the whole catalog. Returns counts.
export async function recomputeItems(env, settings, nowIso) {
  const rows = await catalogRows(env);
  const upsert = env.DB.prepare(
    `INSERT INTO circle_price_items (variant_gid, product_gid, handle, price_cents, circle_price_cents, eligible, reason,
       max_cost_cents, shipping_estimate, computed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(variant_gid) DO UPDATE SET product_gid = ?2, handle = ?3, price_cents = ?4, circle_price_cents = ?5,
       eligible = ?6, reason = ?7, max_cost_cents = ?8, shipping_estimate = ?9, computed_at = ?10`
  );
  let eligible = 0;
  const stmts = rows.map((r) => {
    const c = evaluate(r, settings);
    if (c.eligible) eligible++;
    return upsert.bind(r.variant_gid, r.product_gid, r.handle, r.price_cents, c.circle_price_cents, c.eligible ? 1 : 0,
      c.reason, c.max_cost_cents, c.shipping_estimate === null ? null : c.shipping_estimate ? 1 : 0, nowIso);
  });
  stmts.push(env.DB.prepare("DELETE FROM circle_price_items WHERE variant_gid NOT IN (SELECT variant_gid FROM catalog_variants)"));
  await env.DB.batch(stmts);
  return { variants: rows.length, eligible };
}

// ---- the basis of rules 3 and 4 -----------------------------------------------------

// Variants credits can buy: active, on the Online Store, not a gift card, not
// the membership product.
const creditPurchasable = (r) => r.status === "ACTIVE" && r.published && !r.is_gift_card && exclusionFor(r) !== "membership";

export async function economicsBasis(env, settings) {
  const rows = (await catalogRows(env)).filter(creditPurchasable);
  const variants = rows.map((r) => {
    const c = evaluate(r, settings);
    return { price_cents: c.eligible ? c.circle_price_cents : r.price_cents, cost_cents: r.cost_cents === undefined ? null : r.cost_cents, r };
  });
  const kPpm = costPerCreditPpm(variants);
  const missingCost = variants.filter((v) => !Number.isInteger(v.cost_cents)).length;

  const { results: welcome } = await env.DB.prepare(
    "SELECT landed_cost_cents, shipping_class FROM gift_options WHERE kind = 'welcome' AND active = 1"
  ).all();
  let W = null;
  let ship = null;
  if (welcome.length) {
    let worst = null;
    for (const w of welcome) {
      const s = shippingFor(w.shipping_class, settings);
      if (!s || !Number.isInteger(w.landed_cost_cents)) { worst = null; break; }
      if (!worst || w.landed_cost_cents + s.cents > worst.W + worst.s) worst = { W: w.landed_cost_cents, s: s.cents };
    }
    if (worst) { W = worst.W; ship = worst.s; }
  }
  return { kPpm, missingCost, variantCount: variants.length, welcomeActive: welcome.length, W, ship, variants };
}

// ---- saving ------------------------------------------------------------------------

// Returns { ok: true } or { ok: false, explanation } (rule 3 refused).
export async function saveSettings(ctx, changes) {
  const { env } = ctx;
  const { settings: current, versions } = await loadSettings(env);
  const { next, keys } = applyChanges(current, changes);

  let warning = null;
  if (keys.includes("referral_discount_cents") || keys.includes("referral_reward_cents")) {
    const b = await economicsBasis(env, next);
    const check = referralCheck({ D: next.referral_discount_cents, R: next.referral_reward_cents, W: b.W, s: b.ship, kPpm: b.kPpm }, next);
    if (!check.ok && check.reason === "invitation_costs_more_than_it_brings") return { ok: false, explanation: check };
    if (!check.ok) warning = check.reason; // data missing: saved, rewards stay suspended until it exists
  }

  const nowIso = ctx.nowIso();
  const actor = ctx.admin.email;
  const stmts = [];
  for (const key of keys) {
    const value = JSON.stringify(next[key]);
    const version = (versions[key] || 0) + 1;
    stmts.push(env.DB.prepare(
      `INSERT INTO economics_settings (key, value_json, version, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key) DO UPDATE SET value_json = ?2, version = ?3, updated_by = ?4, updated_at = ?5`
    ).bind(key, value, version, actor, nowIso));
    stmts.push(env.DB.prepare(
      "INSERT INTO economics_settings_history (id, key, value_json, version, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(ctx.newId() + key, key, value, version, actor, nowIso));
  }
  stmts.push(env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, 'economics_settings_saved', 'economics', ?3, ?4)"
  ).bind(ctx.newId(), actor, JSON.stringify(Object.fromEntries(keys.map((k) => [k, next[k]]))), nowIso));
  await env.DB.batch(stmts);
  await recomputeItems(env, next, nowIso);
  return { ok: true, warning };
}

// ---- the Economics screen -----------------------------------------------------------

function profileFigures(s, profile, kPpm) {
  const m = monthlyContribution(kPpm, s, profile);
  return {
    monthly_net_cents: stripeNet(s.monthly_cents, s, profile),
    joining_net_cents: joiningNet(s, profile),
    joining_net_with_invitation_cents: joiningNet(s, profile) - s.referral_discount_cents,
    monthly_contribution_cents: m,
    yearly_contribution_cents: m === null ? null : 12 * m,
    anniversary_budget_cents: anniversaryBudget(kPpm, s, profile),
  };
}

export async function economicsSnapshot(env) {
  const { settings: s, versions } = await loadSettings(env);
  const b = await economicsBasis(env, s);
  const referral = referralCheck({ D: s.referral_discount_cents, R: s.referral_reward_cents, W: b.W, s: b.ship, kPpm: b.kPpm }, s);

  const { results: items } = await env.DB.prepare(
    `SELECT i.variant_gid, i.handle, c.product_title, c.variant_title, i.price_cents, i.reason, i.max_cost_cents, i.eligible
       FROM circle_price_items i JOIN catalog_variants c ON c.variant_gid = i.variant_gid
       JOIN circle_price_list l ON l.variant_gid = i.variant_gid`
  ).all();
  const { results: pool } = await env.DB.prepare(
    "SELECT kind, COUNT(*) AS n FROM gift_options WHERE active = 1 GROUP BY kind"
  ).all();
  const activeOf = (k) => (pool.find((p) => p.kind === k) || { n: 0 }).n;

  let worstItem = null;
  for (const v of b.variants) {
    if (!Number.isInteger(v.cost_cents)) continue;
    const ratio = v.cost_cents / v.price_cents;
    if (!worstItem || ratio > worstItem.ratio) worstItem = { ratio, variant_gid: v.r.variant_gid, handle: v.r.handle };
  }

  const needs = [];
  const estimates = [];
  for (const cls of SHIPPING_CLASSES) {
    if (!Number.isInteger(s.shipping[cls].cents)) needs.push(`shipping ${cls}`);
    else if (s.shipping[cls].estimate) estimates.push(`shipping ${cls}`);
  }
  if (b.missingCost) needs.push(`cost for ${b.missingCost} variants`);
  if (b.variantCount === 0) needs.push("catalog (run the Shopify sync)");
  if (activeOf("welcome") < 2) needs.push("welcome pieces (at least 2 active, landed cost with shipping ≤ $25)");
  if (activeOf("anniversary") < 1) needs.push("anniversary pool");

  return {
    settings: s,
    versions,
    profiles: { expected: profileFigures(s, "expected", b.kPpm), worst: profileFigures(s, "worst", b.kPpm) },
    guard_profile: s.guard_profile,
    cost_per_credit_ppm: b.kPpm,
    brief_c_ppm: b.kPpm === null ? null : Math.ceil((b.kPpm * 3) / 4),
    worst_item: worstItem && { variant_gid: worstItem.variant_gid, handle: worstItem.handle, cost_ratio_ppm: Math.ceil(worstItem.ratio * 1e6) },
    referral,
    anniversary_budget_cents: anniversaryBudget(b.kPpm, s),
    welcome_basis: { landed_cost_cents: b.W, shipping_cents: b.ship },
    circle_price: {
      eligible: items.filter((i) => i.eligible).length,
      excluded: items.filter((i) => !i.eligible).map((i) => ({
        variant_gid: i.variant_gid, handle: i.handle, title: [i.product_title, i.variant_title].filter(Boolean).join(" — "),
        price_cents: i.price_cents, reason: i.reason, max_cost_cents: i.max_cost_cents,
      })),
    },
    needs_data: needs,
    estimates,
  };
}

export { circlePriceCents };
