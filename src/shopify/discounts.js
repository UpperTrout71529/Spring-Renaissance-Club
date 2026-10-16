// The "Circle price" automatic discount (docs/tz-v2-circle.md §7.1).
// Operations validated against 2026-07 (write_discounts, read_discounts).
// 25% on the listed variants, only for the listed customers, combining with
// shipping discounts only.

import { shopifyGraphql } from "./admin.js";

const CREATE = `mutation CirclePriceCreate($input: DiscountAutomaticBasicInput!) {
  discountAutomaticBasicCreate(automaticBasicDiscount: $input) { automaticDiscountNode { id } userErrors { field message code } }
}`;

const UPDATE = `mutation CirclePriceUpdate($id: ID!, $input: DiscountAutomaticBasicInput!) {
  discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $input) { automaticDiscountNode { id } userErrors { field message code } }
}`;

const READ = `query CirclePriceRead($id: ID!) {
  discountNode(id: $id) {
    id
    discount {
      ... on DiscountAutomaticBasic {
        status
        context { ... on DiscountCustomers { customers { id } } }
        customerGets { items { ... on DiscountProducts { productVariants(first: 250) { nodes { id } } } } }
      }
    }
  }
}`;

const FIND = `query CirclePriceFind($query: String!) {
  discountNodes(first: 25, query: $query) { nodes { id discount { __typename ... on DiscountAutomaticBasic { title status } } } }
}`;

const ACTIVATE = `mutation CirclePriceActivate($id: ID!) { discountAutomaticActivate(id: $id) { automaticDiscountNode { id } userErrors { field message } } }`;
const DEACTIVATE = `mutation CirclePriceDeactivate($id: ID!) { discountAutomaticDeactivate(id: $id) { automaticDiscountNode { id } userErrors { field message } } }`;

export const PERCENTAGE = 0.25;
const COMBINES = { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true };

function check(r, what) {
  if (!r || (r.userErrors && r.userErrors.length)) {
    throw new Error(`${what} refused: ${((r && r.userErrors) || []).map((e) => e.code || e.message).join("; ").slice(0, 160)}`);
  }
  return r;
}

export async function createCirclePrice(env, fetchImpl, { title, startsAt, customers, variants }) {
  const data = await shopifyGraphql(env, fetchImpl, CREATE, { input: {
    title, startsAt,
    context: { customers: { add: customers } },
    customerGets: { value: { percentage: PERCENTAGE }, items: { products: { productVariantsToAdd: variants } } },
    combinesWith: COMBINES,
  } });
  const r = check(data.discountAutomaticBasicCreate, "discountAutomaticBasicCreate");
  return r.automaticDiscountNode.id;
}

export async function updateCirclePrice(env, fetchImpl, id, { addCustomers, removeCustomers, addVariants, removeVariants }) {
  const input = {};
  if (addCustomers.length || removeCustomers.length) input.context = { customers: { add: addCustomers, remove: removeCustomers } };
  if (addVariants.length || removeVariants.length) {
    input.customerGets = { value: { percentage: PERCENTAGE }, items: { products: { productVariantsToAdd: addVariants, productVariantsToRemove: removeVariants } } };
  }
  if (!input.context && !input.customerGets) return;
  const data = await shopifyGraphql(env, fetchImpl, UPDATE, { id, input });
  check(data.discountAutomaticBasicUpdate, "discountAutomaticBasicUpdate");
}

// null when the discount no longer exists (deleted by hand).
export async function readCirclePrice(env, fetchImpl, id) {
  const data = await shopifyGraphql(env, fetchImpl, READ, { id });
  const n = data.discountNode;
  if (!n || !n.discount) return null;
  const d = n.discount;
  return {
    status: d.status,
    customers: ((d.context && d.context.customers) || []).map((c) => c.id),
    variants: ((d.customerGets && d.customerGets.items && d.customerGets.items.productVariants && d.customerGets.items.productVariants.nodes) || []).map((v) => v.id),
  };
}

// An automatic discount with exactly this title (one Shopify made even though
// our create call timed out), or null.
export async function findCirclePrice(env, fetchImpl, title) {
  const data = await shopifyGraphql(env, fetchImpl, FIND, { query: `title:"${title}"` });
  const hit = ((data.discountNodes && data.discountNodes.nodes) || [])
    .find((n) => n.discount && n.discount.__typename === "DiscountAutomaticBasic" && n.discount.title === title);
  return hit ? hit.id : null;
}

export async function setCirclePriceActive(env, fetchImpl, id, active) {
  const data = await shopifyGraphql(env, fetchImpl, active ? ACTIVATE : DEACTIVATE, { id });
  check(active ? data.discountAutomaticActivate : data.discountAutomaticDeactivate, active ? "activate" : "deactivate");
}
