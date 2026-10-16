// Side effects of a membership changing state, run after D1 has committed
// (never inside the webhook's transaction): Shopify customer tags
// (spec v1.1 §9.2.2 — vip-circle / vip-circle-past; the waitlist tag goes)
// and the member price (T6 registers grant/revoke). Every effect is
// best-effort and logged; the member-price reconcile (every 5 minutes) and
// the daily Stripe reconcile repair anything that did not get through.

import { addCustomerTags, removeCustomerTags, shopifyConfigured } from "../shopify/admin.js";

export const VIP_TAG = "vip-circle";
export const PAST_TAG = "vip-circle-past";
const WAITLIST_TAG = "circle-waitlist";

export const memberPriceHooks = { grant: null, revoke: null };

async function customerOf(env, userId) {
  const u = await env.DB.prepare("SELECT shopify_customer_id FROM users WHERE id = ?1").bind(userId).first();
  return u && u.shopify_customer_id;
}

async function safely(label, fn) {
  try { await fn(); } catch (e) { console.error("circle effect failed", label, e && e.message); }
}

async function tags(svc, userId, add, remove) {
  if (!shopifyConfigured(svc.env)) return;
  const customer = await customerOf(svc.env, userId);
  if (!customer) return;
  if (add.length) await safely("tags_add", () => addCustomerTags(svc.env, svc.fetch, customer, add));
  if (remove.length) await safely("tags_remove", () => removeCustomerTags(svc.env, svc.fetch, customer, remove));
}

export async function membershipOn(svc, userId) {
  await tags(svc, userId, [VIP_TAG], [PAST_TAG, WAITLIST_TAG]);
  if (memberPriceHooks.grant) await safely("grant", () => memberPriceHooks.grant(svc, userId));
}

// past_due, or a dispute: the member price pauses (spec v1.1 §16.3 #8).
export async function membershipSuspended(svc, userId, reason) {
  await tags(svc, userId, [], [VIP_TAG]);
  if (memberPriceHooks.revoke) await safely("revoke", () => memberPriceHooks.revoke(svc, userId, reason));
}

export async function membershipOff(svc, userId, reason) {
  await tags(svc, userId, [PAST_TAG], [VIP_TAG]);
  if (memberPriceHooks.revoke) await safely("revoke", () => memberPriceHooks.revoke(svc, userId, reason));
}
