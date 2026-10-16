// V2 e2e: a fake Stripe for the Circle and seeding helpers. Used by
// e2e/server.mjs. Nothing here talks to a real service.
//
//   fakeStripe(url, init)            → Response for https://api.stripe.com/*
//   /__e2e/stripe-checkout?cs=ID     → "pays" a Checkout session: delivers
//                                      checkout.session.completed, invoice.paid
//                                      and customer.subscription.updated, then
//                                      redirects to the session's success_url
//   /__e2e/seed-circle               → opens the join gate (shipping S + two
//                                      welcome pieces) — idempotent
//   /__e2e/seed-member?email=&months= → makes a signed-in user a member with
//                                      N paid months (default 1)
//   POST /__e2e/stripe-event         → delivers any Stripe event (JSON body)

export const STRIPE_WHSEC = "whsec_e2e_circle";

export function createCircleFakes({ origin, env, app }) {
  const state = { customers: [], sessions: new Map(), subs: new Map(), seq: 0 };
  const json = (body, status = 200) => Response.json(body, { status });
  const S = (ms) => Math.floor(ms / 1000);

  async function fakeStripe(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    const params = Object.fromEntries(method === "GET" ? u.searchParams : new URLSearchParams(init.body || ""));
    const p = u.pathname;
    if (method === "GET" && p === "/v1/prices") {
      return json({ data: [
        { id: "price_monthly", lookup_key: "circle_monthly_usd", unit_amount: 2000, currency: "usd", active: true, product: "prod_membership", recurring: { interval: "month" } },
        { id: "price_joining", lookup_key: "circle_joining_usd", unit_amount: 3000, currency: "usd", active: true, product: "prod_joining", recurring: null },
      ] });
    }
    if (method === "POST" && p === "/v1/customers") {
      const c = { id: `cus_e2e_${++state.seq}`, email: params.email };
      state.customers.push(c);
      return json(c);
    }
    if (method === "GET" && p === "/v1/customers/search") return json({ data: [] });
    if (method === "POST" && p === "/v1/checkout/sessions") {
      const id = `cs_e2e_${++state.seq}`;
      state.sessions.set(id, params);
      return json({ id, url: `${origin}/__e2e/stripe-checkout?cs=${id}` });
    }
    if (method === "POST" && p === "/v1/coupons") return json({ id: `co_e2e_${++state.seq}` });
    if (method === "GET" && p === "/v1/invoice_payments") {
      const inv = params.invoice || "in_x";
      return json({ data: [{ id: `inpay_${inv}`, invoice: inv, amount_paid: 5000, status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${inv}` } }] });
    }
    if (method === "GET" && p.startsWith("/v1/payment_intents/")) {
      const id = decodeURIComponent(p.split("/").pop());
      return json({ id, latest_charge: { id: id.replace(/^pi_/, "ch_"), payment_method_details: { card: { fingerprint: `fp_${id}`, last4: "4242" } } } });
    }
    if (method === "POST" && p === "/v1/invoices/create_preview") return json({ amount_due: 2000 });
    if (method === "POST" && p === "/v1/billing_portal/sessions") return json({ url: `${origin}/__e2e/billing-portal` });
    if (p.startsWith("/v1/subscriptions/")) {
      const id = decodeURIComponent(p.split("/").pop());
      if (method === "DELETE") return json({ id, status: "canceled" });
      if (method === "POST") return json({ id, status: "active", cancel_at_period_end: params.cancel_at_period_end === "true" });
      return json({ id, status: "active" });
    }
    if (method === "POST" && /^\/v1\/invoices\/[^/]+\/pay$/.test(p)) return json({ id: p.split("/")[3], status: "paid" });
    return json({ error: { type: "invalid_request_error", message: `e2e: no fake for ${method} ${p}` } }, 404);
  }

  async function sign(raw, ts) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(STRIPE_WHSEC), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${raw}`));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function deliver(event) {
    const raw = JSON.stringify(event);
    const ts = S(Date.now());
    const req = new Request(`${origin}/webhooks/stripe`, {
      method: "POST", body: raw,
      headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(raw).length), "Stripe-Signature": `t=${ts},v1=${await sign(raw, ts)}` },
    });
    const pending = [];
    const res = await app.fetch(req, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return res;
  }

  const ev = (type, object) => ({ id: `evt_e2e_${++state.seq}`, object: "event", type, created: S(Date.now()) + state.seq, livemode: false, data: { object } });

  // Joins a user (kind join|rejoin) and pays `months` invoices.
  async function makeMember({ userId, customer, kind = "join", months = 1, discount = 0, referralId = null, sessionId = null }) {
    const sub = `sub_e2e_${++state.seq}`;
    const now = Date.now();
    const DAY = 86400000;
    const meta = { user_id: userId, kind, terms_version: "e2e", ...(referralId ? { referral_id: referralId } : {}) };
    await deliver(ev("checkout.session.completed", {
      id: sessionId || `cs_e2e_${++state.seq}`, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
      customer, subscription: sub, client_reference_id: userId, metadata: meta,
      collected_information: { shipping_details: { name: "E2E Member", address: { line1: "1 Main St", city: "Austin", state: "TX", postal_code: "78701", country: "US" } } },
    }));
    for (let i = 1; i <= months; i++) {
      const start = now - (months - i) * 31 * DAY;
      const end = start + 31 * DAY;
      const lines = [{ id: `il_${sub}_${i}`, amount: 2000, pricing: { price_details: { price: "price_monthly", product: "prod_membership" } }, period: { start: S(start), end: S(end) } }];
      if (i === 1 && kind === "join") lines.push({ id: `il_${sub}_j`, amount: 3000, discount_amounts: discount ? [{ amount: discount }] : [], pricing: { price_details: { price: "price_joining", product: "prod_joining" } }, period: { start: S(start), end: S(start) } });
      const total = lines.reduce((a, l) => a + l.amount, 0) - discount;
      await deliver(ev("invoice.paid", {
        id: `in_${sub}_${i}`, object: "invoice", customer, status: "paid", billing_reason: i === 1 ? "subscription_create" : "subscription_cycle",
        amount_paid: total, amount_due: total, total, hosted_invoice_url: `${origin}/__e2e/invoice/${sub}/${i}`,
        parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: meta } },
        lines: { data: lines }, total_discount_amounts: discount ? [{ amount: discount }] : [], status_transitions: { paid_at: S(start) },
      }));
    }
    await deliver(ev("customer.subscription.updated", {
      id: sub, object: "subscription", customer, status: "active", cancel_at_period_end: false, start_date: S(now), metadata: meta,
      items: { data: [{ id: "si_e2e", current_period_start: S(now), current_period_end: S(now + 31 * DAY) }] }, cancellation_details: { reason: null },
    }));
    state.subs.set(userId, sub);
    return sub;
  }

  async function seedCircle() {
    const db = env.DB._db;
    db.prepare(`INSERT INTO economics_settings (key, value_json, version, updated_by, updated_at) VALUES ('shipping', ?, 1, 'e2e', 'x')
      ON CONFLICT(key) DO NOTHING`).run(JSON.stringify({ S: { cents: 600, estimate: true }, M: { cents: null, estimate: true }, L: { cents: null, estimate: true } }));
    for (const [id, title, cost] of [["gw_e2e_1", "The bell", 1500], ["gw_e2e_2", "The dish", 1800]]) {
      db.prepare(`INSERT OR IGNORE INTO gift_options (id, kind, title, blurb, shopify_variant_gid, landed_cost_cents, shipping_class, active, sort, created_at, updated_at)
        VALUES (?, 'welcome', ?, 'A sealed piece, revealed after joining.', ?, ?, 'S', 1, 0, 'x', 'x')`).run(id, title, `gid://shopify/ProductVariant/9${id.slice(-1)}`, cost);
    }
  }

  // Returns a Response, or null when the path is not one of these.
  async function route(url, req, readBody) {
    if (url.pathname === "/__e2e/stripe-checkout") {
      const id = url.searchParams.get("cs");
      const s = state.sessions.get(id);
      if (!s) return new Response("unknown session", { status: 404 });
      const userId = s.client_reference_id;
      const discount = s["discounts[0][coupon]"] ? 1000 : 0;
      await makeMember({ userId, customer: s.customer, kind: s["subscription_data[metadata][kind]"] || "join", discount,
        referralId: s["subscription_data[metadata][referral_id]"] || null, sessionId: id });
      const success = String(s.success_url || `${origin}/circle/welcome`).replace("{CHECKOUT_SESSION_ID}", id);
      return new Response(null, { status: 302, headers: { Location: success } });
    }
    if (url.pathname === "/__e2e/seed-circle") {
      await seedCircle();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__e2e/seed-member") {
      await seedCircle();
      const email = url.searchParams.get("email");
      const u = env.DB._db.prepare("SELECT id, stripe_customer_id FROM users WHERE email = ?").get(email);
      if (!u) return Response.json({ error: "sign in first" }, { status: 404 });
      const sub = await makeMember({ userId: u.id, customer: u.stripe_customer_id || `cus_e2e_${u.id}`, months: Number(url.searchParams.get("months") || 1) });
      return Response.json({ ok: true, subscription: sub });
    }
    if (url.pathname === "/__e2e/stripe-event" && req.method === "POST") {
      const res = await deliver(JSON.parse(String(await readBody())));
      return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/__e2e/billing-portal" || url.pathname.startsWith("/__e2e/invoice/")) {
      return new Response("<!doctype html><title>Stripe (e2e)</title><p>Stripe page stand-in.</p>", { headers: { "Content-Type": "text/html" } });
    }
    return null;
  }

  return { fakeStripe, route, deliver, makeMember, seedCircle };
}
