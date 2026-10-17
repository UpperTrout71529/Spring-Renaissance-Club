#!/usr/bin/env node
// Circle setup in Stripe TEST mode (docs/v2-blockers.md B1). Run by Felix, one
// command from any folder (PowerShell):
//
//   node C:\Users\FS\Desktop\Spring-Renaissance-Club\scripts\stripe-test-setup.mjs
//
// It asks for the key in a hidden prompt (or takes STRIPE_SECRET_KEY from the
// environment), then:
//   1. refuses anything but a test-mode key (sk_test_… / rk_test_…);
//   2. checks the key's permissions with requests that change nothing (unknown
//      ids or missing parameters) and stops, naming each missing permission;
//   3. creates, only if missing (found by lookup_key / url):
//      Product "The Renaissance Circle — Membership" + price circle_monthly_usd ($20/month, tax exclusive)
//      Product "Joining fee — includes your welcome piece" + price circle_joining_usd ($30 one-time, tax exclusive)
//      A webhook endpoint (default: staging) pinned to 2026-09-30.endive with the Circle events;
//   4. passes the endpoint's signing secret, then the key, to `wrangler secret
//      put … --env <env>` on stdin (STRIPE_CIRCLE_WEBHOOK_SECRET, STRIPE_SECRET_KEY).
// Neither the key nor the signing secret is ever printed. If wrangler fails on
// the signing secret, the endpoint it just created is deleted, so a rerun
// starts clean. Changes nothing else in Stripe.
//
// Options: --webhook <url> (default the staging endpoint), --wrangler-env <env>
// (default staging).

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.stripe.com";
const VERSION = "2026-09-30.endive";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_WEBHOOK = "https://api-staging.springrenaissance.store/webhooks/stripe";

export const WEBHOOK_EVENTS = [
  "checkout.session.completed", "checkout.session.expired",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.refunded", "charge.dispute.created", "charge.dispute.closed",
  "payment_method.attached", "customer.updated",
];

export function assertTestKey(key) {
  if (typeof key !== "string" || !/^(sk|rk)_test_/.test(key)) throw new Error("A Stripe test-mode key (sk_test_… or rk_test_…) is required.");
  if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error("The key has unexpected characters — paste only the key.");
}

// Reads one line without echoing it. In a terminal the input is switched to
// raw mode, so the typed or pasted key never appears on screen; Backspace
// edits, Ctrl+C cancels. Bracketed-paste markers some terminals add are
// dropped. A piped (non-terminal) input is read up to its first line.
export async function readKey({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  if (env.STRIPE_SECRET_KEY) {
    assertTestKey(env.STRIPE_SECRET_KEY);
    return env.STRIPE_SECRET_KEY;
  }
  const raw = !!input.isTTY && typeof input.setRawMode === "function";
  output.write("Paste the Stripe test key (rk_test_… or sk_test_…) and press Enter. The input is hidden: ");
  const typed = await new Promise((resolvePromise, reject) => {
    let value = "";
    const finish = (err) => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      if (raw) input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolvePromise(value);
    };
    function onData(chunk) {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    }
    function onEnd() {
      finish();
    }
    if (raw) input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });
  const key = typed.replace(/\x1b\[20[01]~/g, "").trim();
  assertTestKey(key);
  return key;
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

async function send(key, fetchImpl, method, path, params = {}) {
  const qs = new URLSearchParams(encode(params)).toString();
  return fetchImpl(API + path + (method !== "POST" && qs ? `?${qs}` : ""), {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": VERSION, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? qs : undefined,
  });
}

async function call(key, fetchImpl, method, path, params = {}) {
  const res = await send(key, fetchImpl, method, path, params);
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${(data.error && data.error.message) || res.status}`);
  return data;
}

// One probe per permission the Worker (src/) and this script use. Each request
// changes nothing: it names an id that does not exist ("srprobe") or omits a
// required parameter. Stripe checks a restricted key's permission before it
// looks at the request, so 403 = missing permission; 404/400/200 = allowed.
// `name` is the row and level to set in Dashboard → API keys → restricted key.
export const PERMISSION_PROBES = [
  { name: "Customers — Write", method: "POST", path: "/v1/customers/cus_srprobe" },
  { name: "Charges — Read", method: "GET", path: "/v1/charges/ch_srprobe" },
  { name: "Payment Intents — Read", method: "GET", path: "/v1/payment_intents/pi_srprobe" },
  { name: "Products — Write", method: "POST", path: "/v1/products/prod_srprobe" },
  { name: "Checkout Sessions — Write", method: "POST", path: "/v1/checkout/sessions/cs_test_srprobe/expire" },
  { name: "Coupons — Write", method: "POST", path: "/v1/coupons/srprobe" },
  { name: "Customer portal — Write", method: "POST", path: "/v1/billing_portal/sessions", params: { customer: "cus_srprobe" } },
  { name: "Invoices — Write", method: "POST", path: "/v1/invoices/in_srprobe/pay" },
  { name: "Invoices — Read (invoice payments)", method: "GET", path: "/v1/invoice_payments", params: { invoice: "in_srprobe", limit: 1 } },
  { name: "Prices — Write", method: "POST", path: "/v1/prices/price_srprobe" },
  { name: "Subscriptions — Write", method: "POST", path: "/v1/subscriptions/sub_srprobe" },
  { name: "Webhook Endpoints — Write", method: "POST", path: "/v1/webhook_endpoints/we_srprobe" },
];

export async function checkPermissions(key, fetchImpl = fetch) {
  assertTestKey(key);
  const missing = [];
  for (const p of PERMISSION_PROBES) {
    const res = await send(key, fetchImpl, p.method, p.path, p.params || {});
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Stripe did not accept this key. Copy it again from Dashboard → API keys (test mode).");
    // Stripe's 403 text quotes a redacted key; keep only the permission id it names.
    const named = res.status === 403 && String((data.error && data.error.message) || "").match(/'(rak_[a-z0-9_]+)'/);
    if (res.status === 403) missing.push({ name: p.name, hint: named ? `Stripe: ${named[1]}` : "" });
    else if (res.status === 429 || res.status >= 500) throw new Error(`Stripe answered ${res.status}; nothing was changed. Run the command again in a minute.`);
  }
  return missing;
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
  if ((list.data || []).some((e) => e.url === url)) return { created: false, secret: null, id: null };
  const e = await call(key, fetchImpl, "POST", "/v1/webhook_endpoints", { url, api_version: VERSION, enabled_events: WEBHOOK_EVENTS });
  return { created: true, secret: e.secret, id: e.id };
}

// The value goes to wrangler on stdin, so it is in no argument list and no log.
export function putSecret(name, value, envName) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "secret", "put", name, "--env", envName],
      { cwd: REPO_ROOT, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`wrangler exited with ${code} while saving ${name}`))));
    child.stdin.end(value);
  });
}

export async function run({ key, fetchImpl = fetch, putSecret: put = putSecret, webhookUrl = DEFAULT_WEBHOOK, wranglerEnv = "staging", log = console.log }) {
  assertTestKey(key);
  log(key.startsWith("rk_") ? "Restricted test key received." : "Test secret key received.");
  const missing = await checkPermissions(key, fetchImpl);
  if (missing.length) {
    log("The key is missing these permissions (Dashboard → API keys → the key → Edit):");
    for (const m of missing) log(`  - ${m.name}${m.hint ? `  (${m.hint})` : ""}`);
    throw new Error("Add the permissions above, then run the command again. Nothing was created or saved.");
  }
  log("Permissions: all in place.");
  const cat = await ensureCatalog(key, fetchImpl);
  log(cat.created.length ? `Created: ${cat.created.join(", ")}` : "Catalog already in place.");
  const w = await ensureWebhook(key, fetchImpl, webhookUrl);
  if (w.created) {
    try {
      await put("STRIPE_CIRCLE_WEBHOOK_SECRET", w.secret, wranglerEnv);
    } catch (err) {
      await call(key, fetchImpl, "DELETE", `/v1/webhook_endpoints/${encodeURIComponent(w.id)}`).catch(() => {});
      throw new Error(`${err.message}. The new webhook endpoint was deleted again; nothing else was saved. Run the command again.`);
    }
    log(`Webhook endpoint created for ${webhookUrl}; its signing secret was stored with wrangler (env ${wranglerEnv}).`);
  } else {
    log(`A webhook endpoint for ${webhookUrl} already exists; its secret was not changed.`);
  }
  await put("STRIPE_SECRET_KEY", key, wranglerEnv);
  log(`The key was stored with wrangler as STRIPE_SECRET_KEY (env ${wranglerEnv}). Done.`);
  return { catalog: cat.created, webhook: w.created ? "created" : "exists" };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const key = await readKey();
  await run({ key, webhookUrl: opt("--webhook", DEFAULT_WEBHOOK), wranglerEnv: opt("--wrangler-env", "staging") });
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
