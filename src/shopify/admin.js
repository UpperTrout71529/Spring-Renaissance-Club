// Shopify Admin GraphQL (spec §9.2). Operations validated against the
// 2026-07 schema with Shopify's own validator.
//
// Config: SHOPIFY_SHOP (the *.myshopify.com domain), SHOPIFY_ADMIN_TOKEN
// (secret), SHOPIFY_API_VERSION (default 2026-07, the latest stable listed on
// shopify.dev when this was written). How the "Claude Sync" app gets its token
// — a permanent admin token or client credentials — is task P0.4; until then
// getShopifyToken reads the secret directly.

const DEFAULT_API_VERSION = "2026-07";
const TIMEOUT_MS = 10000;

export function shopifyConfigured(env) {
  return !!(env.SHOPIFY_SHOP && env.SHOPIFY_ADMIN_TOKEN);
}

// TODO(P0.4): client-credentials grant with a KV-cached, refreshed token if
// "Claude Sync" does not have a permanent admin token.
async function getShopifyToken(env) {
  return env.SHOPIFY_ADMIN_TOKEN;
}

export async function shopifyGraphql(env, fetchImpl, query, variables) {
  const version = env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  const res = await fetchImpl(`https://${env.SHOPIFY_SHOP}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await getShopifyToken(env),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`shopify http ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error("shopify graphql errors");
  return data.data;
}

const FIND_CUSTOMER = `query FindCustomer($query: String!) {
  customers(first: 1, query: $query) { nodes { id numberOfOrders } }
}`;

const CREATE_CUSTOMER = `mutation CreateCustomer($input: CustomerInput!) {
  customerCreate(input: $input) { customer { id numberOfOrders } userErrors { field message } }
}`;

const TAG_CUSTOMER = `mutation TagCustomer($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

export const CLUB_TAG = "sr-club";

async function findCustomer(env, fetchImpl, email) {
  // isPlausibleEmail already refuses quotes and backslashes; escape anyway.
  const quoted = email.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const data = await shopifyGraphql(env, fetchImpl, FIND_CUSTOMER, { query: `email:"${quoted}"` });
  return (data.customers && data.customers.nodes && data.customers.nodes[0]) || null;
}

// Spec §9.2.2: find the Shopify customer by email or create one — without
// marketing consent — and make sure it carries the `sr-club` tag. Shopify
// keeps customer emails unique, so two first sign-ins racing each other end
// with one customer: the loser's create fails and it re-reads the winner's.
export async function findOrCreateClubCustomer(env, fetchImpl, email) {
  let customer = await findCustomer(env, fetchImpl, email);
  let created = false;

  if (!customer) {
    const data = await shopifyGraphql(env, fetchImpl, CREATE_CUSTOMER, {
      input: { email, tags: [CLUB_TAG] },
    });
    const result = data.customerCreate || {};
    if (result.customer) {
      customer = result.customer;
      created = true;
    } else {
      customer = await findCustomer(env, fetchImpl, email);
      if (!customer) throw new Error("shopify customerCreate failed");
    }
  }

  if (!created) {
    const data = await shopifyGraphql(env, fetchImpl, TAG_CUSTOMER, { id: customer.id, tags: [CLUB_TAG] });
    const errors = (data.tagsAdd && data.tagsAdd.userErrors) || [];
    if (errors.length) throw new Error("shopify tagsAdd failed");
  }

  return { id: customer.id, created, hadOrders: Number(customer.numberOfOrders || 0) > 0 };
}
