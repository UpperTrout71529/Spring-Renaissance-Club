// Shared V2 test rig: the V1 world (Resend, Turnstile, Shopify customers)
// plus a Shopify GraphQL fake routed by operation name, a Stripe fake, and an
// admin client that passes Cloudflare Access and the admin same-origin check.

import { makeWorld, setup, T0, DAY } from './api-helpers.mjs';
import { accessEnv, makeAccess, withAccess } from './access-helpers.mjs';
import { _resetAccessKeys } from '../src/admin/access.js';
import { get } from './harness.mjs';

export const API_ORIGIN = 'https://w.dev'; // the test requests' own origin (harness builds https://w.dev/...)

// Shopify: handlers by GraphQL operation name → data object (or a function of
// variables). Unknown operations fall through to the V1 world.
export function withShopifyOps(world) {
  world.shopifyOps = {};
  world.shopifyCalls = [];
  const inner = world.fetch;
  world.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('.myshopify.com/admin/api/')) {
      const { query, variables } = JSON.parse(init.body);
      const name = (/(?:query|mutation)\s+(\w+)/.exec(query) || [])[1];
      if (name && world.shopifyOps[name]) {
        world.shopifyCalls.push({ name, variables, query });
        const h = world.shopifyOps[name];
        const out = typeof h === 'function' ? await h(variables, query) : h;
        if (out instanceof Response) return out;
        return Response.json({ data: out });
      }
    }
    return inner(url, init);
  };
  return world;
}

// Stripe: handlers by "METHOD /path" (path params as :name) → JSON body or a
// Response. Calls are recorded with their decoded form params.
export function withStripe(world) {
  world.stripeRoutes = [];
  world.stripeCalls = [];
  world.stripeOn = (method, pattern, handler) => {
    const re = new RegExp('^' + pattern.replace(/:[a-z_]+/g, '([^/]+)') + '$');
    world.stripeRoutes.unshift({ method, re, handler });
  };
  const inner = world.fetch;
  world.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === 'https://api.stripe.com') {
      const method = init.method || 'GET';
      const params = Object.fromEntries(method === 'GET' || method === 'DELETE' ? u.searchParams : new URLSearchParams(init.body || ''));
      const call = { method, path: u.pathname, params, headers: init.headers || {} };
      world.stripeCalls.push(call);
      for (const r of world.stripeRoutes) {
        const m = r.method === method && r.re.exec(u.pathname);
        if (m) {
          const out = await r.handler(call, ...m.slice(1));
          return out instanceof Response ? out : Response.json(out);
        }
      }
      return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', message: `no fake for ${method} ${u.pathname}` } }, { status: 404 });
    }
    return inner(url, init);
  };
  return world;
}

export function makeV2World(opts = {}) {
  return withStripe(withShopifyOps(makeWorld(opts)));
}

// setup() + Access + an admin client. Returns { t, admin, adminSend, world }.
export async function v2Rig({ world = makeV2World(), envOverrides = {} } = {}) {
  _resetAccessKeys();
  const access = await makeAccess();
  withAccess(world, access);
  const t = setup({ world, envOverrides: { ...accessEnv, ...envOverrides } });
  const jwt = await access.sign({ exp: Math.floor((T0 + 400 * DAY) / 1000) });
  const admin = async (path) => {
    const res = await t.call(get(path, { 'Cf-Access-Jwt-Assertion': jwt }));
    return { res, data: (res.headers.get('Content-Type') || '').includes('json') ? JSON.parse(await res.text()) : null };
  };
  const adminSend = async (method, path, payload, headers = {}) => {
    const raw = JSON.stringify(payload ?? {});
    const req = new Request(API_ORIGIN + path, {
      method,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(raw).length),
        'Cf-Access-Jwt-Assertion': jwt, Origin: API_ORIGIN, 'X-SR-Client': 'admin', ...headers,
      },
      body: raw,
    });
    const res = await t.call(req);
    return { res, data: (res.headers.get('Content-Type') || '').includes('json') ? JSON.parse(await res.text()) : null };
  };
  return { t, world, admin, adminSend, access, jwt };
}

// A Shopify catalog page for the CatalogPage operation.
export function catalogProduct({ id, handle, title = handle, status = 'ACTIVE', tags = [], isGiftCard = false, published = true, variants }) {
  return {
    id: `gid://shopify/Product/${id}`, handle, title, status, tags, isGiftCard,
    onlineStoreUrl: published ? `https://springrenaissance.store/products/${handle}` : null,
    variants: { nodes: variants.map((v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, title: v.title || 'Default Title', price: v.price })) },
  };
}

export function serveCatalog(world, products, pageSize = 2) {
  world.shopifyOps.CatalogPage = ({ after }) => {
    const start = after ? Number(after) : 0;
    const nodes = products.slice(start, start + pageSize);
    const end = start + nodes.length;
    return { products: { pageInfo: { hasNextPage: end < products.length, endCursor: String(end) }, nodes } };
  };
}
