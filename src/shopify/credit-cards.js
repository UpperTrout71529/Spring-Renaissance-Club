// Single-use gift cards for spending Circle credits (spec v1.1 §9.2.4).
// Operations validated against 2026-07 (write_gift_cards, read_gift_cards).
// The full code exists only in the create response: it goes to the member
// once (response + email) and is never stored — D1 keeps the last 4 and the id.

import { shopifyGraphql } from "./admin.js";
import { toCents } from "./orders.js";

const CREATE = `mutation CreditsGiftCard($input: GiftCardCreateInput!) {
  giftCardCreate(input: $input) {
    giftCard { id lastCharacters initialValue { amount } }
    giftCardCode
    userErrors { field message code }
  }
}`;

const STATE = `query CreditsGiftCardState($id: ID!) { giftCard(id: $id) { id enabled balance { amount } initialValue { amount } } }`;

const DEACTIVATE = `mutation CreditsGiftCardDeactivate($id: ID!) { giftCardDeactivate(id: $id) { giftCard { id enabled } userErrors { field message } } }`;

export class GiftCardRefused extends Error {}

const amount = (cents) => (cents / 100).toFixed(2);

export async function createCreditCard(env, fetchImpl, { cents, customerId, redemptionId }) {
  const input = { initialValue: amount(cents), note: `Circle credits · ${redemptionId}` };
  if (customerId) input.customerId = customerId;
  const data = await shopifyGraphql(env, fetchImpl, CREATE, { input });
  const r = data.giftCardCreate || {};
  if ((r.userErrors && r.userErrors.length) || !r.giftCard || !r.giftCardCode) {
    throw new GiftCardRefused("giftCardCreate refused");
  }
  return { gid: r.giftCard.id, code: r.giftCardCode, last4: String(r.giftCard.lastCharacters || r.giftCardCode).slice(-4) };
}

export async function creditCardState(env, fetchImpl, gid) {
  const data = await shopifyGraphql(env, fetchImpl, STATE, { id: gid });
  const c = data.giftCard;
  if (!c) return null;
  return { enabled: !!c.enabled, balanceCents: toCents(c.balance.amount), initialCents: toCents(c.initialValue.amount) };
}

export async function deactivateCreditCard(env, fetchImpl, gid) {
  const data = await shopifyGraphql(env, fetchImpl, DEACTIVATE, { id: gid });
  const r = data.giftCardDeactivate || {};
  if ((r.userErrors && r.userErrors.length) || !r.giftCard) throw new Error("giftCardDeactivate refused");
}
