// Gift card balances (spec §9.2.4). Query validated against 2026-07
// (scopes: read_gift_cards, read_orders, read_customers). Only the last
// characters ever leave this module — never a full code.

import { shopifyGraphql } from "./admin.js";
import { numericId, toCents } from "./orders.js";

const CUSTOMER_GIFT_CARDS = `query CustomerGiftCards($query: String!) {
  giftCards(first: 50, query: $query) {
    nodes {
      id
      lastCharacters
      enabled
      expiresOn
      balance { amount currencyCode }
      initialValue { amount currencyCode }
      note
      order { id }
      recipientAttributes { recipient { id } }
    }
  }
}`;

// V2 redemptions note their cards "Circle credits · <redemption_id>" (§9.2.4).
const CREDITS_NOTE = /^Circle credits\b/;

export function giftCardSource(card) {
  if (card.note && CREDITS_NOTE.test(card.note)) return "credits";
  if (card.order) return "purchased";
  return "issued";
}

export async function fetchGiftCards(env, fetchImpl, { customerId }) {
  const id = numericId(customerId);
  if (!id) return { cards: [], total_balance_cents: 0 };
  const data = await shopifyGraphql(env, fetchImpl, CUSTOMER_GIFT_CARDS, { query: `customer_id:${id}` });
  const nodes = (data.giftCards && data.giftCards.nodes) || [];
  const cards = nodes
    .filter((c) => c.enabled)
    // A card bought for someone else is theirs to spend, not the buyer's.
    .filter((c) => !(c.recipientAttributes && c.recipientAttributes.recipient && c.recipientAttributes.recipient.id !== customerId))
    .map((c) => ({
      last4: String(c.lastCharacters || "").slice(-4),
      balance_cents: toCents(c.balance.amount),
      initial_cents: toCents(c.initialValue.amount),
      currency: c.balance.currencyCode,
      expires_on: c.expiresOn || null,
      source: giftCardSource(c),
    }));
  return {
    cards,
    total_balance_cents: cards.reduce((sum, c) => sum + (c.balance_cents || 0), 0),
  };
}
