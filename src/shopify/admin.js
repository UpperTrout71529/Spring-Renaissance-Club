// Shopify Admin GraphQL (spec §9.2). Operations validated against the
// 2026-07 schema with Shopify's own validator.
//
// Config: SHOPIFY_SHOP (the *.myshopify.com domain, wrangler.toml [vars]),
// SHOPIFY_API_VERSION (default 2026-07, the latest stable listed on
// shopify.dev when this was written), and credentials — one of:
//   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (secrets) — "Claude Sync" is a
//     Dev Dashboard app: it has no permanent token and exchanges these for a
//     24-hour access token (client credentials grant);
//   SHOPIFY_ADMIN_TOKEN (secret) — a permanent token, if one is ever issued.

const DEFAULT_API_VERSION = "2026-07";
const TIMEOUT_MS = 10000;
// Refresh this long before Shopify's expiry, so a token never dies mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_KV_KEY = "shopify_token:v1";

export function shopifyConfigured(env) {
  return !!(env.SHOPIFY_SHOP && (env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)));
}

// Per-isolate copy of the token; KV shares it between isolates so a cold
// start does not ask Shopify for a new one every time.
let memo = null; // { token, expiresAt }

export function _resetShopifyTokenCache() {
  memo = null;
}

const fresh = (t) => t && typeof t.token === "string" && t.expiresAt - REFRESH_MARGIN_MS > Date.now();

// Client credentials grant (shopify.dev → Apps → Authentication → Client
// credentials grant): POST https://{shop}/admin/oauth/access_token, form
// encoded, answers { access_token, scope, expires_in } (24 hours). Works only
// when the app and the store belong to the same Shopify organization.
async function requestToken(env, fetchImpl) {
  const res = await fetchImpl(`https://${env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // The body names the reason (e.g. shop_not_permitted) and holds no secret.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`shopify token http ${res.status} ${detail}`);
  }
  const data = await res.json();
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("shopify token: no access_token");
  const ttlSeconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 24 * 60 * 60;
  return { token: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
}

export async function getShopifyToken(env, fetchImpl, { force = false } = {}) {
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return env.SHOPIFY_ADMIN_TOKEN;
  if (!force && fresh(memo)) return memo.token;

  if (!force && env.CLIENT_KV) {
    try {
      const shared = await env.CLIENT_KV.get(TOKEN_KV_KEY, { type: "json" });
      if (fresh(shared)) {
        memo = shared;
        return memo.token;
      }
    } catch (e) {
      console.error("shopify token cache read failed", e && e.name);
    }
  }

  memo = await requestToken(env, fetchImpl);
  if (env.CLIENT_KV) {
    try {
      const ttl = Math.max(60, Math.floor((memo.expiresAt - REFRESH_MARGIN_MS - Date.now()) / 1000));
      await env.CLIENT_KV.put(TOKEN_KV_KEY, JSON.stringify(memo), { expirationTtl: ttl });
    } catch (e) {
      console.error("shopify token cache write failed", e && e.name);
    }
  }
  return memo.token;
}

async function post(env, fetchImpl, token, query, variables) {
  const version = env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  return fetchImpl(`https://${env.SHOPIFY_SHOP}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function shopifyGraphql(env, fetchImpl, query, variables) {
  let res = await post(env, fetchImpl, await getShopifyToken(env, fetchImpl), query, variables);
  // A token revoked or rotated before its expiry: get a new one, retry once.
  if (res.status === 401 && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) {
    res = await post(env, fetchImpl, await getShopifyToken(env, fetchImpl, { force: true }), query, variables);
  }
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
