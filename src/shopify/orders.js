// Orders and tracking from Shopify Admin GraphQL (spec §9.2.3). Both
// operations validated against the 2026-07 schema with Shopify's validator.

import { shopifyGraphql } from "./admin.js";

const CUSTOMER_ORDERS = `query CustomerOrders($id: ID!, $first: Int!, $after: String) {
  customer(id: $id) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentSubtotalLineItemsQuantity
        totalPriceSet { shopMoney { amount currencyCode } }
        fulfillments(first: 10) { displayStatus }
        lineItems(first: 20) { nodes { image { url } sellingPlan { name sellingPlanId } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ORDER_DETAIL = `query OrderDetail($id: ID!) {
  order(id: $id) {
    id
    name
    createdAt
    customer { id }
    displayFinancialStatus
    displayFulfillmentStatus
    totalPriceSet { shopMoney { amount currencyCode } }
    shippingAddress { city }
    lineItems(first: 50) {
      nodes {
        title
        variantTitle
        quantity
        image { url }
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        sellingPlan { name sellingPlanId }
      }
    }
    fulfillments(first: 10) {
      displayStatus
      createdAt
      inTransitAt
      deliveredAt
      estimatedDeliveryAt
      trackingInfo(first: 5) { company number url }
    }
  }
}`;

export const ORDERS_PAGE_SIZE = 10;

// "123.45" → 12345. Exact for any decimal string — no float arithmetic.
export function toCents(amount) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(String(amount ?? ""));
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] || "").padEnd(2, "0") || 0);
  return m[1] ? -cents : cents;
}

export function numericId(gid) {
  const m = /\/(\d+)$/.exec(String(gid || ""));
  return m ? m[1] : null;
}

// Spec §6.4: a line is a pre-order when it carries a pre-order selling plan.
// The store currently sells pre-orders through the theme (sr-preorder), not
// selling plans, so this is false for every line until Felix confirms the
// rule — see docs/v1-decisions.md. Kept as one function so the rule changes
// in one place.
export function isPreorderLine(line) {
  return !!(line && line.sellingPlan);
}

const LIVE = (f) => f && f.displayStatus !== "CANCELED";

// One label per order, from Shopify's own statuses (spec §6.4).
export function orderStatus({ financial, fulfillment, fulfillments, isPreorder }) {
  if (financial === "REFUNDED") return "refunded";
  const live = (fulfillments || []).filter(LIVE);
  if (live.length && live.every((f) => f.displayStatus === "DELIVERED") && fulfillment === "FULFILLED") return "delivered";
  if (live.length || fulfillment === "FULFILLED" || fulfillment === "PARTIALLY_FULFILLED") return "shipped";
  if (isPreorder) return "preorder";
  return "processing";
}

export async function fetchCustomerOrders(env, fetchImpl, { customerId, after }) {
  const data = await shopifyGraphql(env, fetchImpl, CUSTOMER_ORDERS, {
    id: customerId, first: ORDERS_PAGE_SIZE, after: after || null,
  });
  const conn = data.customer && data.customer.orders;
  if (!conn) return { orders: [], next_cursor: null };
  return {
    orders: conn.nodes.map((o) => {
      const lines = (o.lineItems && o.lineItems.nodes) || [];
      const isPreorder = lines.some(isPreorderLine);
      const thumb = lines.find((l) => l.image && l.image.url);
      return {
        id: numericId(o.id),
        name: o.name,
        created_at: o.createdAt,
        total_cents: toCents(o.totalPriceSet.shopMoney.amount),
        currency: o.totalPriceSet.shopMoney.currencyCode,
        financial_status: o.displayFinancialStatus,
        fulfillment_status: o.displayFulfillmentStatus,
        status: orderStatus({
          financial: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus,
          fulfillments: o.fulfillments, isPreorder,
        }),
        is_preorder: isPreorder,
        thumb_url: thumb ? thumb.image.url : null,
        items_count: o.currentSubtotalLineItemsQuantity,
      };
    }),
    next_cursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
  };
}

// Returns the order shaped for §8.3, or null when it does not exist or is not
// this customer's — the caller answers 404 either way.
export async function fetchOrder(env, fetchImpl, { customerId, orderId }) {
  const data = await shopifyGraphql(env, fetchImpl, ORDER_DETAIL, { id: `gid://shopify/Order/${orderId}` });
  const o = data.order;
  if (!o || !o.customer || o.customer.id !== customerId) return null;

  const lines = (o.lineItems && o.lineItems.nodes) || [];
  const isPreorder = lines.some(isPreorderLine);
  const fulfillments = [];
  for (const f of (o.fulfillments || []).filter(LIVE)) {
    const base = {
      status: f.displayStatus,
      shipped_at: f.inTransitAt || f.createdAt || null,
      delivered_at: f.deliveredAt || null,
      // Only what Shopify knows; the UI shows no date when this is null.
      estimated_delivery_at: f.estimatedDeliveryAt || null,
    };
    const tracking = (f.trackingInfo || []).filter((t) => t && (t.number || t.url));
    if (!tracking.length) fulfillments.push({ ...base, carrier: null, tracking_number: null, tracking_url: null });
    // One entry per tracking number: a split shipment shows every parcel.
    for (const t of tracking) {
      fulfillments.push({ ...base, carrier: t.company || null, tracking_number: t.number || null, tracking_url: t.url || null });
    }
  }

  return {
    id: numericId(o.id),
    name: o.name,
    created_at: o.createdAt,
    total_cents: toCents(o.totalPriceSet.shopMoney.amount),
    currency: o.totalPriceSet.shopMoney.currencyCode,
    financial_status: o.displayFinancialStatus,
    fulfillment_status: o.displayFulfillmentStatus,
    status: orderStatus({
      financial: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus,
      fulfillments: o.fulfillments, isPreorder,
    }),
    is_preorder: isPreorder,
    line_items: lines.map((l) => ({
      title: l.title,
      variant_title: l.variantTitle || null,
      qty: l.quantity,
      price_cents: toCents(l.originalUnitPriceSet && l.originalUnitPriceSet.shopMoney.amount),
      image_url: (l.image && l.image.url) || null,
      is_preorder: isPreorderLine(l),
    })),
    fulfillments,
    shipping_city: (o.shippingAddress && o.shippingAddress.city) || null,
  };
}
