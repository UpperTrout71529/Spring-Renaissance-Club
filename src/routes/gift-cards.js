// GET /api/gift-cards (spec §8.3, §9.2.4; S6): the customer's enabled cards,
// last 4 characters only, and the total balance in cents. Cached in KV for 5
// minutes per user.

import { HttpError } from "../http/errors.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { fetchGiftCards } from "../shopify/gift-cards.js";
import { cached } from "../lib/kv-cache.js";
import { customerIdOf } from "./orders.js";

const unavailable = () =>
  new HttpError(503, "gift_cards_unavailable", "We couldn't load your gift cards right now. Please try again in a moment.");

export async function listGiftCards(ctx) {
  const { env, session, json } = ctx;
  const customerId = await customerIdOf(env, session.user.id);
  if (!customerId) return json({ cards: [], total_balance_cents: 0 });
  if (!shopifyConfigured(env)) throw unavailable();
  try {
    return json(await cached(env, `gift_cards:v1:${session.user.id}`,
      () => fetchGiftCards(env, ctx.fetch, { customerId })));
  } catch (e) {
    console.error("gift cards: shopify failed", e && e.message);
    throw unavailable();
  }
}
