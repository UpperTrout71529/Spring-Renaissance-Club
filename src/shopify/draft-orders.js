// Draft orders for the Circle (spec v1.1 §9.2.6; docs/tz-v2-circle.md §8,
// §10): welcome pieces and anniversary gifts ($0, completed at once) and the
// members' object (priced, paid through the invoice link). Operations
// validated against 2026-07 (write_draft_orders). Every draft refuses the
// automatic "Circle price" discount and discount codes.

import { shopifyGraphql } from "./admin.js";

const CREATE = `mutation CircleDraftCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id invoiceUrl status order { id } }
    userErrors { field message }
  }
}`;

const COMPLETE = `mutation CircleDraftComplete($id: ID!) {
  draftOrderComplete(id: $id) { draftOrder { id status order { id } } userErrors { field message } }
}`;

const STATE = `query CircleDraftState($id: ID!) { draftOrder(id: $id) { id status invoiceUrl order { id } } }`;

const DELETE = `mutation CircleDraftDelete($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { field message } } }`;

const AVAILABLE = `query CircleVariantsAvailable($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id availableForSale } } }`;

// Stripe's shipping (name + address) → Shopify MailingAddressInput.
export function mailingAddress(shipping) {
  const a = (shipping && shipping.address) || {};
  const name = String((shipping && shipping.name) || "").trim();
  const space = name.indexOf(" ");
  return {
    firstName: space > 0 ? name.slice(0, space) : name || null,
    lastName: space > 0 ? name.slice(space + 1) : null,
    address1: a.line1 || null,
    address2: a.line2 || null,
    city: a.city || null,
    provinceCode: a.state || null,
    zip: a.postal_code || null,
    countryCode: a.country || "US",
  };
}

// lines: [{ variantId, quantity, priceOverrideCents?, free?: title }]
export async function createDraftOrder(env, fetchImpl, { customerId, lines, shipping, shippingTitle, tags, note, reserveUntil = null }) {
  const input = {
    purchasingEntity: customerId ? { customerId } : undefined,
    lineItems: lines.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity || 1,
      ...(Number.isInteger(l.priceOverrideCents) ? { priceOverride: { amount: (l.priceOverrideCents / 100).toFixed(2), currencyCode: "USD" } } : {}),
      ...(l.free ? { appliedDiscount: { valueType: "PERCENTAGE", value: 100, title: l.free } } : {}),
    })),
    shippingAddress: shipping ? mailingAddress(shipping) : undefined,
    shippingLine: { title: shippingTitle, priceWithCurrency: { amount: "0.00", currencyCode: "USD" } },
    tags,
    note,
    acceptAutomaticDiscounts: false,
    allowDiscountCodesInCheckout: false,
    ...(reserveUntil ? { reserveInventoryUntil: reserveUntil } : {}),
  };
  const data = await shopifyGraphql(env, fetchImpl, CREATE, { input });
  const r = data.draftOrderCreate || {};
  if ((r.userErrors && r.userErrors.length) || !r.draftOrder) {
    throw new Error(`draftOrderCreate refused: ${((r.userErrors || []).map((e) => e.message).join("; ")).slice(0, 160)}`);
  }
  return { id: r.draftOrder.id, invoiceUrl: r.draftOrder.invoiceUrl };
}

// Completes a draft as paid (the $0 gifts). Returns the order gid.
export async function completeDraftOrder(env, fetchImpl, id) {
  const data = await shopifyGraphql(env, fetchImpl, COMPLETE, { id });
  const r = data.draftOrderComplete || {};
  if ((r.userErrors && r.userErrors.length) || !r.draftOrder || !r.draftOrder.order) throw new Error("draftOrderComplete refused");
  return r.draftOrder.order.id;
}

export async function draftOrderState(env, fetchImpl, id) {
  const data = await shopifyGraphql(env, fetchImpl, STATE, { id });
  const d = data.draftOrder;
  return d ? { status: d.status, orderId: d.order ? d.order.id : null, invoiceUrl: d.invoiceUrl } : null;
}

export async function deleteDraftOrder(env, fetchImpl, id) {
  const data = await shopifyGraphql(env, fetchImpl, DELETE, { input: { id } });
  const r = data.draftOrderDelete || {};
  if (r.userErrors && r.userErrors.length) throw new Error("draftOrderDelete refused");
}

// Map gid → availableForSale (a missing variant counts as unavailable).
export async function variantsAvailable(env, fetchImpl, ids) {
  if (!ids.length) return new Map();
  const data = await shopifyGraphql(env, fetchImpl, AVAILABLE, { ids });
  const out = new Map(ids.map((id) => [id, false]));
  for (const n of data.nodes || []) if (n && n.id) out.set(n.id, !!n.availableForSale);
  return out;
}
