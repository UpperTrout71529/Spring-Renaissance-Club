// The Circle in V1 (spec §6.3, §6.6, §8.3; S8): the teaser's data, the
// waitlist ("Reserve a place"), and "Not now".
//
// sealed_count: the number of Welcome piece options lives in gift_options,
// a V2 table that does not exist yet, so V1 always answers 0 and
// show_count false — the copy then names no number (§6.3).

import { addCustomerTags, shopifyConfigured } from "../shopify/admin.js";
import { memberPriceCents, productsByIds } from "../shopify/products.js";
import { recordEvent } from "../lib/events.js";
import { customerIdOf } from "./orders.js";

export const WAITLIST_TAG = "circle-waitlist";
const MAX_EXAMPLES = 3;

async function onWaitlist(env, userId) {
  const row = await env.DB.prepare(
    "SELECT 1 AS yes FROM holds WHERE user_id = ?1 AND kind = 'circle_waitlist' AND status = 'open' LIMIT 1"
  ).bind(userId).first();
  return !!row;
}

// GET /api/circle/teaser → { sealed_count, show_count, member_price_examples,
// snoozed_until, on_waitlist }
export async function getTeaser(ctx) {
  const { env, session, json } = ctx;
  const user = await env.DB.prepare("SELECT circle_teaser_snoozed_until FROM users WHERE id = ?1")
    .bind(session.user.id).first();
  const snoozed = user && user.circle_teaser_snoozed_until > ctx.nowIso() ? user.circle_teaser_snoozed_until : null;

  // §6.3: "With the Circle, {Object} would be $…" — only for saved pieces the
  // member price applies to, and only from a real Shopify price.
  let examples = [];
  const rows = (await env.DB.prepare(
    "SELECT product_gid FROM wishlist_items WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20"
  ).bind(session.user.id).all()).results;
  if (rows.length && shopifyConfigured(env)) {
    try {
      const products = await productsByIds(env, ctx.fetch, rows.map((r) => r.product_gid));
      examples = rows
        .map((r) => products.get(r.product_gid))
        .filter((p) => p && p.available && p.member_price_eligible && Number.isInteger(p.price_cents) && p.price_cents > 0)
        .slice(0, MAX_EXAMPLES)
        .map((p) => ({ handle: p.handle, title: p.title, price_cents: p.price_cents, member_price_cents: memberPriceCents(p.price_cents) }));
    } catch (e) {
      console.error("teaser: shopify failed", e && e.message);
    }
  }

  return json({
    sealed_count: 0,
    show_count: false,
    member_price_examples: examples,
    snoozed_until: snoozed,
    on_waitlist: await onWaitlist(env, session.user.id),
  });
}

// POST /api/circle/waitlist → 201 { on_waitlist: true }. One open place per
// person; the Shopify tag is added when the place is first taken (and, if
// Shopify was unreachable then, at the next sign-in — see afterSignIn).
export async function joinWaitlist(ctx) {
  const { env, session, json } = ctx;
  const nowIso = ctx.nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO holds (id, user_id, kind, source, status, created_at)
     SELECT ?1, ?2, 'circle_waitlist', 'portal', 'open', ?3
      WHERE NOT EXISTS (SELECT 1 FROM holds WHERE user_id = ?2 AND kind = 'circle_waitlist' AND status = 'open')`
  ).bind(ctx.newId(), session.user.id, nowIso).run();

  if (res.meta && res.meta.changes === 1) {
    await recordEvent(env, { id: ctx.newId(), userId: session.user.id, name: "circle_waitlist_joined", createdAt: nowIso });
    const customerId = await customerIdOf(env, session.user.id);
    if (customerId && shopifyConfigured(env)) {
      ctx.waitUntil(addCustomerTags(env, ctx.fetch, customerId, [WAITLIST_TAG])
        .catch((e) => console.error("waitlist tag failed", e && e.message)));
    }
  }
  return json({ on_waitlist: true }, 201);
}

// At sign-in: a waitlist place whose tag never reached Shopify gets it now.
export async function syncWaitlistTag(env, fetchImpl, userId, customerId, tags) {
  if ((tags || []).includes(WAITLIST_TAG)) return;
  if (!(await onWaitlist(env, userId))) return;
  await addCustomerTags(env, fetchImpl, customerId, [WAITLIST_TAG]);
}
