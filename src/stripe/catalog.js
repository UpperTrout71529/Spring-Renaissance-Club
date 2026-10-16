// The Circle's Stripe catalog, resolved by lookup_key (never by id, spec
// §9.1.1): Product A "The Renaissance Circle — Membership" with the monthly
// price, and Product B "Joining fee — includes your welcome piece" with the
// one-time joining price (V2 Δ4: its own product, so the invitation coupon can
// target it alone). Cached in KV for an hour.

import { StripeError, stripeRequest } from "./client.js";

export const PRICE_KEYS = { monthly: "circle_monthly_usd", joining: "circle_joining_usd" };
const CACHE_KEY = "circle_prices_v1";
const TTL_MS = 60 * 60 * 1000;

function incomplete(what) {
  return new StripeError(503, "stripe_catalog_incomplete", `Stripe catalog incomplete: ${what}`);
}

export async function resolvePrices(env, fetchImpl, nowMs) {
  const cached = env.CLIENT_KV ? await env.CLIENT_KV.get(CACHE_KEY, { type: "json" }).catch(() => null) : null;
  if (cached && cached.at && nowMs - cached.at < TTL_MS) return cached.prices;

  const list = await stripeRequest(env, fetchImpl, "GET", "/v1/prices", {
    lookup_keys: Object.values(PRICE_KEYS), active: true, limit: 10,
  });
  const byKey = new Map((list.data || []).map((p) => [p.lookup_key, p]));
  const pick = (name, recurring) => {
    const p = byKey.get(PRICE_KEYS[name]);
    if (!p || p.active === false) throw incomplete(`${PRICE_KEYS[name]} missing`);
    if (p.currency !== "usd" || !Number.isInteger(p.unit_amount)) throw incomplete(`${PRICE_KEYS[name]} not a USD amount`);
    if (recurring !== !!(p.recurring && p.recurring.interval === "month")) throw incomplete(`${PRICE_KEYS[name]} wrong type`);
    const product = typeof p.product === "string" ? p.product : p.product && p.product.id;
    return { id: p.id, product, unit_amount: p.unit_amount };
  };
  const prices = { monthly: pick("monthly", true), joining: pick("joining", false) };
  if (env.CLIENT_KV) await env.CLIENT_KV.put(CACHE_KEY, JSON.stringify({ at: nowMs, prices })).catch(() => {});
  return prices;
}
