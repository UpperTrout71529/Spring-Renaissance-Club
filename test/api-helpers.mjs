// Shared API test rig: a fake outside world (Resend, Turnstile, Shopify), an
// app with an injectable clock, and sign-in helpers. Used by S2 and S4 tests.

import assert from 'node:assert/strict';
import { makeEnv, post } from './harness.mjs';
import { createApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';

export const CLUB = 'https://club.springrenaissance.store';
export const T0 = Date.parse('2026-10-15T12:00:00.000Z');
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const trusted = { Origin: CLUB, 'X-SR-Client': 'portal' };

// ---- a fake outside world: Resend, Turnstile, Shopify ----------------------

export function makeWorld({ turnstileOk = true, resendOk = true, shopifyCustomers = [] } = {}) {
  const world = {
    emails: [],
    turnstileCalls: 0,
    shopify: { customers: shopifyCustomers.map((c) => ({ tags: [], numberOfOrders: '0', ...c })), creates: 0, tagged: [] },
  };
  world.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) {
      if (!resendOk) return new Response('{}', { status: 500 });
      world.emails.push({ ...JSON.parse(init.body), idempotencyKey: init.headers['Idempotency-Key'] });
      return Response.json({ id: `re_${world.emails.length}` });
    }
    if (u.startsWith('https://challenges.cloudflare.com/')) {
      world.turnstileCalls++;
      return Response.json({ success: turnstileOk && init.body.get('response') === 'ok-token' });
    }
    if (u.includes('.myshopify.com/admin/api/')) {
      assert.equal(init.headers['X-Shopify-Access-Token'], 'shpat_test');
      const { query, variables } = JSON.parse(init.body);
      const s = world.shopify;
      // Yield so concurrent callers genuinely interleave around the store.
      await new Promise((r) => setTimeout(r, 0));
      if (query.includes('customers(')) {
        const email = /email:"(.*)"/.exec(variables.query)[1];
        const c = s.customers.find((x) => x.email === email);
        return Response.json({ data: { customers: { nodes: c ? [{ id: c.id, numberOfOrders: c.numberOfOrders }] : [] } } });
      }
      if (query.includes('customerCreate')) {
        const { email, tags } = variables.input;
        if (s.customers.some((x) => x.email === email)) {
          return Response.json({ data: { customerCreate: { customer: null, userErrors: [{ field: ['email'], message: 'Email has already been taken' }] } } });
        }
        s.creates++;
        const c = { id: `gid://shopify/Customer/${100 + s.customers.length}`, email, tags: [...tags], numberOfOrders: '0' };
        s.customers.push(c);
        return Response.json({ data: { customerCreate: { customer: { id: c.id, numberOfOrders: '0' }, userErrors: [] } } });
      }
      if (query.includes('tagsAdd')) {
        const c = s.customers.find((x) => x.id === variables.id);
        c.tags.push(...variables.tags);
        s.tagged.push(variables.id);
        return Response.json({ data: { tagsAdd: { userErrors: [] } } });
      }
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return world;
}

export function setup({ world = makeWorld(), envOverrides = {} } = {}) {
  let nowMs = T0;
  const pending = [];
  const env = makeEnv({
    SESSION_PEPPER: 'pepper',
    TURNSTILE_SECRET: 'ts_secret',
    RESEND_API_KEY: 're_key',
    SHOPIFY_SHOP: 'example.myshopify.com',
    SHOPIFY_ADMIN_TOKEN: 'shpat_test',
    ...envOverrides,
  });
  const app = createApp({ now: () => nowMs, fetch: world.fetch });
  const executionCtx = { waitUntil: (p) => pending.push(p) };
  const call = async (req) => {
    const res = await app.fetch(req, env, executionCtx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return {
    env, world, call,
    setNow: (ms) => { nowMs = ms; },
    rows: (sql, ...a) => env.DB._rows(sql, ...a),
  };
}

export const requestLink = (email, extra = {}, headers = {}) =>
  post('/api/auth/magic-link', { email, turnstile_token: 'ok-token', ...extra }, { ...trusted, ...headers });
export const verify = (token, headers = {}) => post('/api/auth/verify', { token }, { ...trusted, ...headers });

export function tokenFromEmail(email) {
  return /#t=([A-Za-z0-9_-]{43})/.exec(email.text)[1];
}

export function sessionToken(res) {
  const c = res.headers.get('Set-Cookie') || '';
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(c);
  return m ? m[1] : null;
}

export async function signIn(t, email = 'clara@example.com') {
  await t.call(requestLink(email));
  const token = tokenFromEmail(t.world.emails.at(-1));
  const res = await t.call(verify(token));
  return { res, token, cookie: `${SESSION_COOKIE}=${sessionToken(res)}` };
}

export const body = async (res) => JSON.parse(await res.text());

