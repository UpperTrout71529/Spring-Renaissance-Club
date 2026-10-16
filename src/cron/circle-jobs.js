// Circle cron jobs (spec v1.1 §9.1.5, §9.4, §11, §16.3; docs/tz-v2-circle.md
// §6.1, §15). Each job is idempotent: emails are keyed in email_log, ledger
// rows by idempotency key, so a re-run or an overlap never doubles anything.
// Workers Free: 50 subrequests per run — batches are small and rotate.

import { stripeConfigured, stripeRequest } from "../stripe/client.js";
import { balanceCents, ledgerEntry } from "../circle/ledger.js";
import { emailUser } from "../circle/notify.js";
import { processStripeEvent } from "../circle/stripe-events.js";
import { recordEvent } from "../lib/events.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const iso = (ms) => new Date(ms).toISOString();
const day = (s) => String(s).slice(0, 10);

// §9.1.5: 72 hours before every charge, with Stripe's amount (tax included).
export async function renewalReminders(svc) {
  const { env } = svc;
  if (!stripeConfigured(env)) return { skipped: "stripe" };
  const now = svc.now();
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.user_id, m.stripe_subscription_id, m.stripe_customer_id, m.current_period_end FROM memberships m
      WHERE m.status = 'active' AND m.current_period_end > ?1 AND m.current_period_end <= ?2 LIMIT 10`
  ).bind(iso(now + 60 * HOUR_MS), iso(now + 73 * HOUR_MS)).all();
  let sent = 0;
  for (const m of results) {
    const key = `renewal_reminder:${m.stripe_subscription_id}:${day(m.current_period_end)}`;
    const done = await env.DB.prepare("SELECT 1 AS yes FROM email_log WHERE dedupe_key = ?1").bind(key).first();
    if (done) continue;
    let amount;
    try {
      const inv = await stripeRequest(env, svc.fetch, "POST", "/v1/invoices/create_preview",
        { customer: m.stripe_customer_id || undefined, subscription: m.stripe_subscription_id });
      amount = inv.amount_due;
    } catch (e) {
      console.error("renewal preview failed", e && e.code);
      continue; // the next run inside the window tries again
    }
    if ((await emailUser(svc, m.user_id, "renewal_reminder", key, { chargeOn: day(m.current_period_end), amountCents: amount })) === "sent") sent++;
  }
  return { sent };
}

// §16.3 #16: at credits_grace_until the remaining balance expires — unless the
// person has rejoined, in which case the balance stays (§16.3 #15).
export async function creditsExpiry(svc) {
  const { env } = svc;
  const nowIso = svc.nowIso();
  const { results } = await env.DB.prepare(
    "SELECT id, user_id FROM memberships WHERE status = 'ended' AND credits_grace_until IS NOT NULL AND credits_grace_until <= ?1 LIMIT 50"
  ).bind(nowIso).all();
  let expired = 0;
  for (const m of results) {
    const live = await env.DB.prepare(
      "SELECT 1 AS yes FROM memberships WHERE user_id = ?1 AND status IN ('pending','active','past_due','canceling') LIMIT 1"
    ).bind(m.user_id).first();
    const stmts = [env.DB.prepare("UPDATE memberships SET status = 'ended_expired', updated_at = ?1 WHERE id = ?2 AND status = 'ended'").bind(nowIso, m.id)];
    const balance = live ? 0 : await balanceCents(env, m.user_id);
    if (balance > 0) {
      stmts.push(ledgerEntry(env, { id: svc.newId(), userId: m.user_id, membershipId: m.id, amountCents: -balance, kind: "expiry",
        memo: "Expired after membership ended", key: `expiry:${m.id}`, createdAt: nowIso }));
    }
    await env.DB.batch(stmts);
    if (balance > 0) {
      expired++;
      await recordEvent(env, { id: `credits_expired:${m.id}`, userId: m.user_id, name: "credits_expired", props: { amount_cents: balance }, createdAt: nowIso });
    }
  }
  return { memberships: results.length, expired };
}

// §11: 7 days and 1 day before the credits expire, when there is a balance.
export async function creditsExpiring(svc) {
  const { env } = svc;
  const now = svc.now();
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, credits_grace_until FROM memberships WHERE status = 'ended' AND credits_grace_until > ?1 AND credits_grace_until <= ?2"
  ).bind(iso(now), iso(now + 7 * DAY_MS)).all();
  let sent = 0;
  for (const m of results) {
    const live = await env.DB.prepare(
      "SELECT 1 AS yes FROM memberships WHERE user_id = ?1 AND status IN ('pending','active','past_due','canceling') LIMIT 1"
    ).bind(m.user_id).first();
    if (live) continue;
    const balance = await balanceCents(env, m.user_id);
    if (balance <= 0) continue;
    const left = Date.parse(m.credits_grace_until) - now;
    const which = left <= DAY_MS ? 1 : 7;
    const r = await emailUser(svc, m.user_id, "credits_expiring", `credits_expiring:${m.id}:${which}`,
      { balanceCents: balance, expiresOn: day(m.credits_grace_until) });
    if (r === "sent") sent++;
  }
  return { sent };
}

// §16.3 #19: one reminder on the third day.
export async function welcomeReminders(svc) {
  const { env } = svc;
  const nowIso = svc.nowIso();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.user_id FROM gift_selections s
      WHERE s.status = 'awaiting_choice' AND s.reminded_at IS NULL AND s.created_at <= ?1
        AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = s.user_id AND m.status IN ('active','past_due','canceling'))
      LIMIT 50`
  ).bind(iso(svc.now() - 3 * DAY_MS)).all();
  for (const s of results) {
    await emailUser(svc, s.user_id, "welcome_piece_reminder", `welcome_piece_reminder:${s.id}`, {});
    await env.DB.prepare("UPDATE gift_selections SET reminded_at = ?1 WHERE id = ?2").bind(nowIso, s.id).run();
  }
  return { sent: results.length };
}

// §6.1: missed webhooks. A few memberships per run, in rotation: the
// subscription and its latest invoices are read from Stripe and replayed
// through the same handlers (idempotent by object id).
const RECONCILE_BATCH = 3;
const CURSOR_KEY = "circle_reconcile_cursor";

export async function stripeReconcile(svc) {
  const { env } = svc;
  if (!stripeConfigured(env)) return { skipped: "stripe" };
  const cursor = (env.CLIENT_KV && (await env.CLIENT_KV.get(CURSOR_KEY).catch(() => null))) || "";
  let { results } = await env.DB.prepare(
    "SELECT id, stripe_subscription_id FROM memberships WHERE status IN ('pending','active','past_due','canceling') AND id > ?1 ORDER BY id LIMIT ?2"
  ).bind(cursor, RECONCILE_BATCH).all();
  if (results.length === 0 && cursor) {
    results = (await env.DB.prepare(
      "SELECT id, stripe_subscription_id FROM memberships WHERE status IN ('pending','active','past_due','canceling') ORDER BY id LIMIT ?1"
    ).bind(RECONCILE_BATCH).all()).results;
  }
  const nowS = Math.floor(svc.now() / 1000);
  let replayed = 0;
  for (const m of results) {
    try {
      const sub = await stripeRequest(env, svc.fetch, "GET", `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`, {});
      const invoices = await stripeRequest(env, svc.fetch, "GET", "/v1/invoices", { subscription: m.stripe_subscription_id, limit: 3 });
      for (const inv of (invoices.data || []).slice().reverse()) {
        if (inv.status !== "paid") continue;
        const known = await env.DB.prepare("SELECT 1 AS yes FROM membership_invoices WHERE invoice_id = ?1 AND status = 'paid'").bind(inv.id).first();
        if (known) continue;
        const paidAt = (inv.status_transitions && inv.status_transitions.paid_at) || nowS;
        await processStripeEvent(svc, { id: `reconcile:${inv.id}`, type: "invoice.paid", created: paidAt, data: { object: inv } });
        replayed++;
      }
      const type = sub.status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated";
      await processStripeEvent(svc, { id: `reconcile:${m.id}:${nowS}`, type, created: nowS, data: { object: sub } });
    } catch (e) {
      console.error("reconcile failed", m.id, e && (e.code || e.message));
    }
  }
  const last = results.at(-1);
  if (env.CLIENT_KV) await env.CLIENT_KV.put(CURSOR_KEY, last ? last.id : "").catch(() => {});
  return { memberships: results.length, replayed };
}
