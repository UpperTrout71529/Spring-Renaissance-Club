#!/usr/bin/env node
// Circle setup in Stripe TEST mode (docs/v2-blockers.md B1). Run by Felix:
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-test-setup.mjs [--webhook <url>] [--wrangler-env staging]
//
// Creates, only if missing (found by lookup_key / url):
//   Product "The Renaissance Circle — Membership" + price circle_monthly_usd ($20/month, tax exclusive)
//   Product "Joining fee — includes your welcome piece" + price circle_joining_usd ($30 one-time, tax exclusive)
//   With --webhook: an endpoint pinned to 2026-09-30.endive with the Circle events.
//     Its signing secret is passed straight to `wrangler secret put
//     STRIPE_CIRCLE_WEBHOOK_SECRET --env <env>` on stdin — never printed.
// Refuses any key that is not a test-mode key. Changes nothing else in Stripe.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const API = "https://api.stripe.com";
const VERSION = "2026-09-30.endive";

export const WEBHOOK_EVENTS = [
  "checkout.session.completed", "checkout.session.expired",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.refunded", "charge.dispute.created", "charge.dispute.closed",
  "payment_method.attached", "customer.updated",
];

export function assertTestKey(key) {
  if (typeof key !== "string" || !/^(sk|rk)_test_/.test(key)) throw new Error("A Stripe test-mode key (sk_test_… or rk_test_…) is required.");
}

function encode(params, prefix = "", out = []) {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => out.push([`${key}[${i}]`, String(x)]));
    else if (v && typeof v === "object") encode(v, key, out);
    else if (v !== undefined && v !== null) out.push([key, String(v)]);
  }
  return out;
}

async function call(key, fetchImpl, method, path, params = {}) {
  const qs = new URLSearchParams(encode(params)).toString();
  const res = await fetchImpl(API + path + (method === "GET" && qs ? `?${qs}` : ""), {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": VERSION, ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
    body: method === "GET" ? undefined : qs,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${(data.error && data.error.message) || res.status}`);
  return data;
}

const CATALOG = [
  { lookup_key: "circle_monthly_usd", product: "The Renaissance Circle — Membership", unit_amount: 2000, recurring: { interval: "month" } },
  { lookup_key: "circle_joining_usd", product: "Joining fee — includes your welcome piece", unit_amount: 3000, recurring: null },
];

export async function ensureCatalog(key, fetchImpl = fetch) {
  assertTestKey(key);
  const existing = await call(key, fetchImpl, "GET", "/v1/prices", { lookup_keys: CATALOG.map((c) => c.lookup_key), active: true });
  const have = new Set((existing.data || []).map((p) => p.lookup_key));
  const created = [];
  for (const c of CATALOG) {
    if (have.has(c.lookup_key)) continue;
    const product = await call(key, fetchImpl, "POST", "/v1/products", { name: c.product });
    await call(key, fetchImpl, "POST", "/v1/prices", {
      product: product.id, currency: "usd", unit_amount: c.unit_amount, tax_behavior: "exclusive",
      lookup_key: c.lookup_key, ...(c.recurring ? { recurring: c.recurring } : {}),
    });
    created.push(c.lookup_key);
  }
  return { created };
}

export async function ensureWebhook(key, fetchImpl = fetch, url) {
  assertTestKey(key);
  const list = await call(key, fetchImpl, "GET", "/v1/webhook_endpoints", { limit: 100 });
  if ((list.data || []).some((e) => e.url === url)) return { created: false, secret: null };
  const e = await call(key, fetchImpl, "POST", "/v1/webhook_endpoints", { url, api_version: VERSION, enabled_events: WEBHOOK_EVENTS });
  return { created: true, secret: e.secret };
}

function putSecret(envName, secret) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "secret", "put", "STRIPE_CIRCLE_WEBHOOK_SECRET", "--env", envName],
      { stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler exited with ${code}`))));
    child.stdin.end(secret);
  });
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  assertTestKey(key);
  const args = process.argv.slice(2);
  const webhook = args.includes("--webhook") ? args[args.indexOf("--webhook") + 1] : null;
  const wranglerEnv = args.includes("--wrangler-env") ? args[args.indexOf("--wrangler-env") + 1] : "staging";
  const cat = await ensureCatalog(key);
  console.log(cat.created.length ? `Created: ${cat.created.join(", ")}` : "Catalog already in place.");
  if (webhook) {
    const w = await ensureWebhook(key, fetch, webhook);
    if (w.created) {
      await putSecret(wranglerEnv, w.secret);
      console.log(`Webhook endpoint created; its signing secret was stored with wrangler (env ${wranglerEnv}).`);
    } else {
      console.log("A webhook endpoint for that URL already exists; its secret was not changed.");
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
