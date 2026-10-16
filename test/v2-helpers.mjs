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
  const world = withStripe(withShopifyOps(makeWorld(opts)));
  const cust = (id) => world.shopify.customers.find((c) => c.id === id);
  world.shopifyOps.TagCustomer = ({ id, tags }) => {
    const c = cust(id);
    if (c) for (const t of tags) if (!c.tags.includes(t)) c.tags.push(t);
    world.shopify.tagged.push(id);
    return { tagsAdd: { userErrors: [] } };
  };
  world.shopifyOps.UntagCustomer = ({ id, tags }) => {
    const c = cust(id);
    if (c) c.tags = c.tags.filter((t) => !tags.includes(t));
    return { tagsRemove: { userErrors: [] } };
  };
  return world;
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

// ---- Stripe basics: catalog, customers, Checkout --------------------------------

export const PRICES = {
  monthly: { id: 'price_monthly', lookup_key: 'circle_monthly_usd', unit_amount: 2000, currency: 'usd', active: true, product: 'prod_membership', recurring: { interval: 'month' } },
  joining: { id: 'price_joining', lookup_key: 'circle_joining_usd', unit_amount: 3000, currency: 'usd', active: true, product: 'prod_joining', recurring: null },
};

export function stripeBasics(world) {
  world.stripe = { customers: [], sessions: [] };
  world.stripeOn('GET', '/v1/prices', () => ({ data: [PRICES.monthly, PRICES.joining] }));
  world.stripeOn('POST', '/v1/customers', (call) => {
    const c = { id: `cus_${world.stripe.customers.length + 1}`, email: call.params.email, metadata: { user_id: call.params['metadata[user_id]'] } };
    world.stripe.customers.push(c);
    return c;
  });
  world.stripeOn('POST', '/v1/checkout/sessions', (call) => {
    const s = { id: `cs_test_${world.stripe.sessions.length + 1}`, url: `https://checkout.stripe.com/c/pay/cs_test_${world.stripe.sessions.length + 1}`, params: call.params };
    world.stripe.sessions.push(s);
    return { id: s.id, url: s.url };
  });
  return world;
}

export const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_fake', CIRCLE_JOIN_OPEN: 'on', PORTAL_URL: 'https://club.springrenaissance.store' };

// Two active welcome pieces and exact shipping for class S, so the join gate opens.
export function seedWelcomeSet(t, { shippingCents = 600 } = {}) {
  const db = t.env.DB._db;
  db.prepare(`INSERT INTO economics_settings (key, value_json, version, updated_by, updated_at) VALUES ('shipping', ?, 1, 'test', 'x')
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify({
    S: { cents: shippingCents, estimate: false }, M: { cents: null, estimate: true }, L: { cents: null, estimate: true },
  }));
  for (const [id, cost] of [['gw1', 1500], ['gw2', 1800]]) {
    db.prepare(`INSERT INTO gift_options (id, kind, title, blurb, shopify_variant_gid, image_url, landed_cost_cents, shipping_class, active, sort, created_at, updated_at)
      VALUES (?, 'welcome', ?, 'A sealed piece.', ?, NULL, ?, 'S', 1, 0, 'x', 'x')`).run(id, `Piece ${id}`, `gid://shopify/ProductVariant/9${id.slice(2)}`, cost);
  }
}

// ---- Stripe events -------------------------------------------------------------

import { signBody } from './harness.mjs';

export const CIRCLE_WHSEC = 'whsec_circle_test';
const S = (ms) => Math.floor(ms / 1000);
let evtSeq = 0;

export function stripeEvent(type, object, { id, created, livemode = false, previous } = {}) {
  evtSeq++;
  return { id: id || `evt_${evtSeq}_${type}`, object: 'event', type, created: created ?? S(T0) + evtSeq, livemode,
    data: { object, ...(previous ? { previous_attributes: previous } : {}) } };
}

export async function deliver(t, event, { secret = CIRCLE_WHSEC, ts } = {}) {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  const stamp = ts ?? S(T0);
  const req = new Request('https://w.dev/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(raw).length),
      'Stripe-Signature': `t=${stamp},v1=${await signBody(raw, stamp, secret)}` },
    body: raw,
  });
  const res = await t.call(req);
  return { res, data: JSON.parse(await res.text()) };
}

export const fx = {
  session: ({ userId, sub = 'sub_1', customer = 'cus_1', kind = 'join', id = 'cs_test_1', referralId } = {}) => ({
    id, object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', customer, subscription: sub,
    client_reference_id: userId, metadata: { user_id: userId, kind, terms_version: 'membership-terms-draft-2026-10-16', ...(referralId ? { referral_id: referralId } : {}) },
    customer_details: { email: 'clara@example.com', name: 'Clara Moss' },
    collected_information: { shipping_details: { name: 'Clara Moss', address: { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } },
  }),
  subscription: ({ id = 'sub_1', customer = 'cus_1', status = 'active', userId, kind = 'join', start = T0, end = T0 + 31 * DAY, cancelAtPeriodEnd = false, reason = null, endedAt = null } = {}) => ({
    id, object: 'subscription', customer, status, cancel_at_period_end: cancelAtPeriodEnd, cancel_at: null, start_date: S(start),
    ended_at: endedAt ? S(endedAt) : null, canceled_at: endedAt ? S(endedAt) : null,
    metadata: { user_id: userId, kind }, cancellation_details: { reason },
    items: { data: [{ id: 'si_1', price: { id: 'price_monthly' }, current_period_start: S(start), current_period_end: S(end) }] },
  }),
  invoice: ({ id = 'in_1', sub = 'sub_1', customer = 'cus_1', userId, kind = 'join', reason = 'subscription_create', start = T0, end = T0 + 31 * DAY,
    monthly = 2000, joining = reason === 'subscription_create' && kind === 'join' ? 3000 : 0, tax = 0, discount = 0, attempt = 1, next = null, status = 'paid' } = {}) => {
    const lines = [{ id: `il_${id}_m`, amount: monthly, pricing: { price_details: { price: 'price_monthly', product: 'prod_membership' } }, period: { start: S(start), end: S(end) } }];
    if (joining) lines.push({ id: `il_${id}_j`, amount: joining, discount_amounts: discount ? [{ amount: discount, discount: 'di_1' }] : [],
      pricing: { price_details: { price: 'price_joining', product: 'prod_joining' } }, period: { start: S(start), end: S(start) } });
    const total = monthly + joining - discount + tax;
    return {
      id, object: 'invoice', customer, status, billing_reason: reason, amount_paid: status === 'paid' ? total : 0, amount_due: total, total,
      hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, attempt_count: attempt, next_payment_attempt: next,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub, metadata: { user_id: userId, kind } } },
      lines: { data: lines }, total_discount_amounts: discount ? [{ amount: discount, discount: 'di_1' }] : [],
      status_transitions: { paid_at: status === 'paid' ? S(start) : null },
    };
  },
};

// Stripe fakes for the payment map: invoice → payment intent → charge.
export function stripePayments(world, { fingerprint = 'fp_clara', wallet = null } = {}) {
  world.stripeOn('GET', '/v1/invoice_payments', (call) => {
    const inv = call.params.invoice;
    const pi = call.params['payment[payment_intent]'];
    if (inv) return { data: [{ id: `inpay_${inv}`, invoice: inv, amount_paid: 5000, status: 'paid', payment: { type: 'payment_intent', payment_intent: `pi_${inv}` } }] };
    if (pi) return { data: [{ id: `inpay_${pi}`, invoice: pi.replace(/^pi_/, ''), amount_paid: 5000, status: 'paid', payment: { type: 'payment_intent', payment_intent: pi } }] };
    return { data: [] };
  });
  world.stripeOn('GET', '/v1/payment_intents/:id', (call, id) => ({
    id, latest_charge: { id: id.replace(/^pi_/, 'ch_'), payment_method_details: { card: { fingerprint: typeof fingerprint === 'function' ? fingerprint(id) : fingerprint, last4: '4242', wallet: wallet ? { type: wallet } : null } } },
  }));
  return world;
}
