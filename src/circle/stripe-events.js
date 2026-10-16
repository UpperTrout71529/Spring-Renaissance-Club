// Stripe events → Circle state (docs/tz-v2-circle.md §6.1, §9; spec v1.1
// §9.1.4). Snapshot payloads, API 2026-09-30.endive:
//   invoice → subscription:  invoice.parent.subscription_details.subscription
//   invoice line → price:     line.pricing.price_details.price / .product
//   subscription period:      items.data[0].current_period_start/_end
//   charge → invoice:         our stripe_payments map (charge.invoice is gone),
//                             else GET /v1/invoice_payments?payment[...]
//
// Rules: Stripe objects are keyed by their own ids (invoice, charge,
// dispute) as well as by event id, because Stripe can send two events for one
// change; subscription snapshots older than the last applied one are ignored
// (stripe_synced_at); `ended` is terminal. D1 changes are committed first,
// side effects (Shopify, email) run afterwards through svc.waitUntil.
// Only Circle subscriptions are handled (metadata.kind join/rejoin, set by our
// Checkout); anything else in the account is "ignored".

import { resolvePrices } from "../stripe/catalog.js";
import { stripeRequest } from "../stripe/client.js";
import { balanceCents, ledgerEntry, monthName } from "./ledger.js";
import { emailUser, notifyFelix, raiseFlag } from "./notify.js";
import { membershipOff, membershipOn, membershipSuspended } from "./effects.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const GRACE_DAYS = 30;
const CIRCLE_KINDS = new Set(["join", "rejoin"]);
const ENDED = new Set(["ended", "ended_expired"]);

// Later tasks register here: (svc, payload) => Promise.
export const circleHooks = {
  sessionCompleted: [], sessionExpired: [], invoicePaid: [], subscriptionEnded: [], chargeRefunded: [], dispute: [],
};

const isoOf = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const addDaysIso = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

export const subscriptionIdOfInvoice = (inv) =>
  (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription)
  || (typeof inv.subscription === "string" ? inv.subscription : null);
const subscriptionMetaOfInvoice = (inv) =>
  (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.metadata) || {};
const linePrice = (l) => (l.pricing && l.pricing.price_details && l.pricing.price_details.price) || (l.price && l.price.id) || null;
const lineProduct = (l) => (l.pricing && l.pricing.price_details && l.pricing.price_details.product) || (l.price && l.price.product) || null;
const lineDiscount = (l) => (l.discount_amounts || []).reduce((a, d) => a + (d.amount || 0), 0);
const periodOfSubscription = (sub) => {
  const item = sub.items && sub.items.data && sub.items.data[0];
  return { start: isoOf(item && item.current_period_start), end: isoOf(item && item.current_period_end) };
};

async function runHooks(list, svc, payload) {
  for (const h of list) await h(svc, payload);
}

function later(svc, label, fn) {
  svc.waitUntil(Promise.resolve().then(fn).catch((e) => console.error("circle after-effect failed", label, e && e.message)));
}

// ---- membership lookups -----------------------------------------------------

const bySubscription = (env, subId) =>
  env.DB.prepare("SELECT * FROM memberships WHERE stripe_subscription_id = ?1").bind(subId).first();

async function resolveUser(env, metaUserId, customerId) {
  if (metaUserId) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(metaUserId).first();
    if (u) return u.id;
  }
  if (customerId) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?1").bind(customerId).first();
    if (u) return u.id;
  }
  return null;
}

// The membership for a Circle subscription, created (pending) on first sight
// whichever event arrives first. null = not a Circle subscription.
async function ensureMembership(svc, { subId, customerId, meta }) {
  if (!subId) return null;
  const existing = await bySubscription(svc.env, subId);
  if (existing) return existing;
  if (!meta || !CIRCLE_KINDS.has(meta.kind)) return null;
  const userId = await resolveUser(svc.env, meta.user_id, customerId);
  if (!userId) throw new Error("circle subscription without a known user");
  const nowIso = svc.nowIso();
  await svc.env.DB.prepare(
    `INSERT INTO memberships (id, user_id, stripe_subscription_id, stripe_customer_id, kind, status, terms_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?7) ON CONFLICT(stripe_subscription_id) DO NOTHING`
  ).bind(svc.newId(), userId, subId, customerId || null, meta.kind, meta.terms_version || null, nowIso).run();
  const m = await bySubscription(svc.env, subId);
  // Two live memberships for one person (e.g. two Checkouts on different days).
  const other = await svc.env.DB.prepare(
    `SELECT id FROM memberships WHERE user_id = ?1 AND id <> ?2 AND status IN ('pending','active','past_due','canceling') LIMIT 1`
  ).bind(userId, m.id).first();
  if (other) {
    later(svc, "duplicate_flag", () => raiseFlag(svc, {
      kind: "duplicate_subscription", dedupeKey: `duplicate_subscription:${subId}`, userId, ref: subId,
      title: "A member has two subscriptions",
      lines: [`Subscription ${subId} started while membership ${other.id} is still live. Refund and cancel one of them in Stripe.`],
    }));
  }
  return m;
}

const statusAfterPayment = (m) => (m.cancel_requested_at ? "canceling" : "active");

function statusFromSubscription(sub) {
  switch (sub.status) {
    case "active":
    case "trialing":
      return sub.cancel_at_period_end || sub.cancel_at ? "canceling" : "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "ended";
    default:
      return "pending";
  }
}

async function setTier(env, userId) {
  const live = await env.DB.prepare(
    "SELECT 1 AS yes FROM memberships WHERE user_id = ?1 AND status IN ('active','past_due','canceling') LIMIT 1"
  ).bind(userId).first();
  await env.DB.prepare("UPDATE users SET tier = ?1 WHERE id = ?2").bind(live ? "vip" : "club", userId).run();
}

function transitionEffects(svc, userId, prev, next) {
  if (prev === next) return;
  if ((next === "active" || next === "canceling") && !(prev === "active" || prev === "canceling")) {
    later(svc, "on", () => membershipOn(svc, userId));
  } else if (next === "past_due") {
    later(svc, "suspend", () => membershipSuspended(svc, userId, "past_due"));
  }
}

// ---- checkout.session.completed ---------------------------------------------------

async function onSessionCompleted(svc, event) {
  const s = event.data.object;
  const meta = s.metadata || {};
  if (s.mode !== "subscription" || !CIRCLE_KINDS.has(meta.kind)) return "ignored";
  const m = await ensureMembership(svc, { subId: s.subscription, customerId: s.customer, meta });
  if (!m) return "ignored";
  const { env } = svc;
  const nowIso = svc.nowIso();
  const shipping = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || null;
  const stmts = [
    env.DB.prepare(
      `UPDATE memberships SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
         started_at = COALESCE(started_at, ?1), stripe_customer_id = COALESCE(stripe_customer_id, ?2), updated_at = ?1
       WHERE id = ?3`
    ).bind(nowIso, s.customer || null, m.id),
    env.DB.prepare("UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?1) WHERE id = ?2").bind(s.customer || null, m.user_id),
    env.DB.prepare("UPDATE holds SET status = 'converted' WHERE user_id = ?1 AND kind = 'circle_waitlist' AND status = 'open'").bind(m.user_id),
  ];
  if (m.kind === "join") {
    // One welcome piece per person, ever (spec v1.1 §7 uq_gift_per_user).
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO gift_selections (id, membership_id, user_id, status, shipping_json, created_at, updated_at)
       SELECT ?1, ?2, ?3, 'awaiting_choice', ?4, ?5, ?5
        WHERE NOT EXISTS (SELECT 1 FROM gift_selections WHERE user_id = ?3 AND status <> 'canceled')`
    ).bind(svc.newId(), m.id, m.user_id, shipping ? JSON.stringify({ name: shipping.name || null, address: shipping.address || null }) : null, nowIso));
  }
  await env.DB.batch(stmts);
  await setTier(env, m.user_id);
  if (m.status === "pending") transitionEffects(svc, m.user_id, "pending", "active");
  await runHooks(circleHooks.sessionCompleted, svc, { session: s, membership: m });
  return "processed";
}

async function onSessionExpired(svc, event) {
  const s = event.data.object;
  if (!CIRCLE_KINDS.has((s.metadata || {}).kind)) return "ignored";
  await runHooks(circleHooks.sessionExpired, svc, { session: s });
  return "processed";
}

// ---- customer.subscription.* --------------------------------------------------------

async function onSubscriptionSnapshot(svc, event) {
  const sub = event.data.object;
  const m = await ensureMembership(svc, { subId: sub.id, customerId: sub.customer, meta: sub.metadata || {} });
  if (!m) return "ignored";
  if (ENDED.has(m.status)) return "processed";
  if (m.stripe_synced_at > event.created) return "processed"; // an older snapshot
  const next = statusFromSubscription(sub);
  if (next === "ended") return endMembership(svc, m, sub);
  const period = periodOfSubscription(sub);
  const nowIso = svc.nowIso();
  const cancelling = !!(sub.cancel_at_period_end || sub.cancel_at);
  await svc.env.DB.prepare(
    `UPDATE memberships SET status = ?1, current_period_start = COALESCE(?2, current_period_start),
       current_period_end = COALESCE(?3, current_period_end),
       cancel_requested_at = CASE WHEN ?4 = 1 THEN COALESCE(cancel_requested_at, ?5) ELSE NULL END,
       started_at = COALESCE(started_at, ?6), stripe_synced_at = ?7, updated_at = ?5
     WHERE id = ?8 AND status NOT IN ('ended','ended_expired')`
  ).bind(next, period.start, period.end, cancelling ? 1 : 0, nowIso, isoOf(sub.start_date), event.created, m.id).run();
  await setTier(svc.env, m.user_id);
  transitionEffects(svc, m.user_id, m.status, next);
  return "processed";
}

async function endMembership(svc, m, sub) {
  const { env } = svc;
  if (ENDED.has(m.status)) return "processed";
  const nowIso = svc.nowIso();
  const lastPaid = await env.DB.prepare(
    "SELECT MAX(period_end) AS p FROM membership_invoices WHERE membership_id = ?1 AND status = 'paid'"
  ).bind(m.id).first();
  const lastPaidEnd = (lastPaid && lastPaid.p) || m.last_paid_period_end || null;
  const endedAt = isoOf(sub.ended_at) || isoOf(sub.canceled_at) || nowIso;
  const reason = m.end_reason === "account_deleted" ? "account_deleted"
    : (sub.cancellation_details && sub.cancellation_details.reason === "payment_failed") ? "payment_failed" : "canceled";
  const grace = lastPaidEnd ? addDaysIso(lastPaidEnd, GRACE_DAYS) : endedAt;
  await env.DB.prepare(
    `UPDATE memberships SET status = 'ended', ended_at = ?1, end_reason = ?2, last_paid_period_end = ?3, credits_grace_until = ?4,
       updated_at = ?5 WHERE id = ?6 AND status NOT IN ('ended','ended_expired')`
  ).bind(endedAt, reason, lastPaidEnd, grace, nowIso, m.id).run();
  await setTier(env, m.user_id);
  later(svc, "off", () => membershipOff(svc, m.user_id, "ended"));
  if (reason !== "account_deleted") {
    later(svc, "ended_email", async () => {
      const balance = await balanceCents(env, m.user_id);
      if (reason === "payment_failed") {
        await emailUser(svc, m.user_id, "membership_ended_payment", `membership_ended:${m.id}`, { graceUntil: grace, balanceCents: Math.max(0, balance) });
      } else {
        // Shares its key with the cancel flow, so a member who cancelled in the portal gets it once.
        await emailUser(svc, m.user_id, "membership_canceled", `membership_canceled:${m.id}`,
          { endsOn: endedAt, graceUntil: grace, balanceCents: Math.max(0, balance) });
      }
    });
  }
  await runHooks(circleHooks.subscriptionEnded, svc, { membership: m, reason });
  return "processed";
}

async function onSubscriptionDeleted(svc, event) {
  const sub = event.data.object;
  const m = await ensureMembership(svc, { subId: sub.id, customerId: sub.customer, meta: sub.metadata || {} });
  if (!m) return "ignored";
  return endMembership(svc, m, sub);
}

// ---- invoices ----------------------------------------------------------------------

async function invoiceContext(svc, inv) {
  const subId = subscriptionIdOfInvoice(inv);
  if (!subId) return null;
  const m = await ensureMembership(svc, { subId, customerId: inv.customer, meta: subscriptionMetaOfInvoice(inv) });
  return m ? { m, subId } : null;
}

function splitLines(inv, prices) {
  const lines = (inv.lines && inv.lines.data) || [];
  const isMonthly = (l) => linePrice(l) === prices.monthly.id || lineProduct(l) === prices.monthly.product;
  const isJoining = (l) => linePrice(l) === prices.joining.id || lineProduct(l) === prices.joining.product;
  const monthly = lines.filter(isMonthly);
  const joining = lines.filter(isJoining);
  const sum = (ls) => ls.reduce((a, l) => a + (l.amount || 0) - lineDiscount(l), 0);
  const period = (monthly[0] && monthly[0].period) || (lines[0] && lines[0].period) || {};
  return {
    monthlyCents: sum(monthly),
    joiningCents: sum(joining),
    discountCents: (inv.total_discount_amounts || []).reduce((a, d) => a + (d.amount || 0), 0),
    periodStart: isoOf(period.start), periodEnd: isoOf(period.end),
  };
}

function upsertInvoice(env, { inv, subId, m, split, status, hadFailure, nowIso }) {
  return env.DB.prepare(
    `INSERT INTO membership_invoices (invoice_id, subscription_id, membership_id, billing_reason, period_start, period_end,
       amount_paid_cents, monthly_cents, joining_cents, discount_cents, status, had_failure, paid_at, hosted_invoice_url, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(invoice_id) DO UPDATE SET
       status = CASE WHEN membership_invoices.status = 'paid' THEN 'paid' ELSE excluded.status END,
       had_failure = MAX(membership_invoices.had_failure, excluded.had_failure),
       amount_paid_cents = COALESCE(excluded.amount_paid_cents, membership_invoices.amount_paid_cents),
       paid_at = COALESCE(membership_invoices.paid_at, excluded.paid_at),
       hosted_invoice_url = COALESCE(excluded.hosted_invoice_url, membership_invoices.hosted_invoice_url)`
  ).bind(inv.id, subId, m.id, inv.billing_reason || "unknown", split.periodStart || nowIso, split.periodEnd || nowIso,
    status === "paid" ? inv.amount_paid : null, split.monthlyCents, split.joiningCents, split.discountCents,
    status, hadFailure ? 1 : 0, status === "paid" ? (isoOf(inv.status_transitions && inv.status_transitions.paid_at) || nowIso) : null,
    inv.hosted_invoice_url || null, nowIso);
}

// Charge → invoice map and the card fingerprint (invitations, refunds).
async function recordPayment(svc, inv, m) {
  const { env } = svc;
  const list = await stripeRequest(env, svc.fetch, "GET", "/v1/invoice_payments", { invoice: inv.id, status: "paid", limit: 10 });
  for (const p of list.data || []) {
    const piId = p.payment && p.payment.type === "payment_intent" ? p.payment.payment_intent : null;
    if (!piId || typeof piId !== "string") continue;
    const pi = await stripeRequest(env, svc.fetch, "GET", `/v1/payment_intents/${encodeURIComponent(piId)}`, { expand: ["latest_charge"] });
    const ch = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const card = ch && ch.payment_method_details && ch.payment_method_details.card;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO stripe_payments (payment_intent_id, charge_id, invoice_id, user_id, card_fingerprint, wallet, amount_cents, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(piId, ch ? ch.id : null, inv.id, m.user_id, (card && card.fingerprint) || null,
      (card && card.wallet && card.wallet.type) || null, p.amount_paid || inv.amount_paid || 0, svc.nowIso()).run();
  }
}

async function onInvoicePaid(svc, event) {
  const inv = event.data.object;
  const ctx = await invoiceContext(svc, inv);
  if (!ctx) return "ignored";
  const { m, subId } = ctx;
  const { env } = svc;
  const nowIso = svc.nowIso();
  const reason = inv.billing_reason;
  const prices = await resolvePrices(env, svc.fetch, svc.now());
  const split = splitLines(inv, prices);
  const accrues = reason === "subscription_create" || reason === "subscription_cycle";
  const first = reason === "subscription_create";
  const welcome = first && m.kind === "join";
  const wasNew = !(await env.DB.prepare("SELECT 1 AS yes FROM membership_invoices WHERE invoice_id = ?1 AND status = 'paid'").bind(inv.id).first());

  const stmts = [
    upsertInvoice(env, { inv, subId, m, split, status: "paid", hadFailure: false, nowIso }),
    env.DB.prepare(
      `UPDATE memberships SET
         paid_invoices = (SELECT COUNT(*) FROM membership_invoices WHERE membership_id = ?1 AND status = 'paid'),
         consecutive_paid_months = (SELECT COUNT(*) FROM membership_invoices WHERE membership_id = ?1 AND status = 'paid'),
         last_paid_period_end = (SELECT MAX(period_end) FROM membership_invoices WHERE membership_id = ?1 AND status = 'paid'),
         current_period_end = CASE WHEN current_period_end IS NULL OR current_period_end < ?2 THEN ?2 ELSE current_period_end END,
         started_at = COALESCE(started_at, ?3), updated_at = ?3
       WHERE id = ?1`
    ).bind(m.id, split.periodEnd, nowIso),
  ];
  if (accrues && split.monthlyCents > 0) {
    stmts.push(ledgerEntry(env, {
      id: svc.newId(), userId: m.user_id, membershipId: m.id, amountCents: split.monthlyCents,
      kind: welcome ? "welcome_accrual" : "accrual", ref: inv.id,
      memo: welcome ? "Welcome — first month" : `Monthly credits — ${monthName(split.periodStart || nowIso)}`,
      key: `accrual:${inv.id}`, createdAt: nowIso,
    }));
  }
  // A payment recovers past_due (and confirms a pending membership), unless a
  // newer Stripe snapshot already said otherwise.
  let next = m.status;
  if ((m.status === "past_due" || m.status === "pending") && event.created >= m.stripe_synced_at) {
    next = statusAfterPayment(m);
    stmts.push(env.DB.prepare(
      "UPDATE memberships SET status = ?1, stripe_synced_at = ?2 WHERE id = ?3 AND status IN ('past_due','pending')"
    ).bind(next, event.created, m.id));
  }
  await env.DB.batch(stmts);
  await setTier(env, m.user_id);
  transitionEffects(svc, m.user_id, m.status, next);

  later(svc, "payment_map", () => recordPayment(svc, inv, m));
  if (wasNew) {
    later(svc, "paid_email", async () => {
      if (first) {
        await emailUser(svc, m.user_id, m.kind === "join" ? "welcome" : "welcome_back", `welcome:${m.id}`, {
          invoiceUrl: inv.hosted_invoice_url || null, monthlyCents: prices.monthly.unit_amount, nextChargeOn: split.periodEnd,
        });
      } else if (accrues) {
        await emailUser(svc, m.user_id, "credits_added", `credits_added:${inv.id}`, {
          invoiceUrl: inv.hosted_invoice_url || null, amountCents: split.monthlyCents, balanceCents: await balanceCents(env, m.user_id),
        });
      }
    });
  }
  await runHooks(circleHooks.invoicePaid, svc, { invoice: inv, membership: { ...m, status: next }, split, wasNew });
  return "processed";
}

const PAYMENT_ATTEMPTS = (env) => Number.parseInt(env.CIRCLE_PAYMENT_ATTEMPTS || "4", 10) || 4;

async function onInvoicePaymentFailed(svc, event) {
  const inv = event.data.object;
  const ctx = await invoiceContext(svc, inv);
  if (!ctx) return "ignored";
  const { m, subId } = ctx;
  const { env } = svc;
  const nowIso = svc.nowIso();
  const prices = await resolvePrices(env, svc.fetch, svc.now());
  const split = splitLines(inv, prices);
  const stmts = [upsertInvoice(env, { inv, subId, m, split, status: "open", hadFailure: true, nowIso })];
  let next = m.status;
  if ((m.status === "active" || m.status === "canceling") && event.created >= m.stripe_synced_at) {
    next = "past_due";
    stmts.push(env.DB.prepare(
      "UPDATE memberships SET status = 'past_due', stripe_synced_at = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('active','canceling')"
    ).bind(event.created, nowIso, m.id));
  }
  await env.DB.batch(stmts);
  transitionEffects(svc, m.user_id, m.status, next);
  // §9.1.4: on the first failure and before the last retry; none when no retry is left.
  const attempt = inv.attempt_count || 1;
  if (inv.next_payment_attempt && (attempt === 1 || attempt === PAYMENT_ATTEMPTS(env) - 1)) {
    later(svc, "failed_email", () => emailUser(svc, m.user_id, "payment_failed", `payment_failed:${inv.id}:${attempt}`, { amountCents: inv.amount_due }));
  }
  return "processed";
}

async function onInvoiceActionRequired(svc, event) {
  const inv = event.data.object;
  const ctx = await invoiceContext(svc, inv);
  if (!ctx || !inv.hosted_invoice_url) return ctx ? "processed" : "ignored";
  later(svc, "action_email", () => emailUser(svc, ctx.m.user_id, "payment_action_required", `payment_action:${inv.id}`,
    { hostedInvoiceUrl: inv.hosted_invoice_url, amountCents: inv.amount_due }));
  return "processed";
}

// ---- refunds and disputes --------------------------------------------------------------

async function paymentFor(svc, { paymentIntent, chargeId }) {
  const { env } = svc;
  let p = await env.DB.prepare(
    "SELECT * FROM stripe_payments WHERE (payment_intent_id = ?1 AND ?1 IS NOT NULL) OR (charge_id = ?2 AND ?2 IS NOT NULL) LIMIT 1"
  ).bind(paymentIntent || null, chargeId || null).first();
  if (p || !paymentIntent) return p;
  // Not mapped yet (the after-effect may not have run): ask Stripe.
  const list = await stripeRequest(env, svc.fetch, "GET", "/v1/invoice_payments",
    { payment: { type: "payment_intent", payment_intent: paymentIntent }, limit: 1 });
  const ip = list.data && list.data[0];
  if (!ip || typeof ip.invoice !== "string") return null;
  const inv = await env.DB.prepare(
    "SELECT i.invoice_id, m.user_id FROM membership_invoices i JOIN memberships m ON m.id = i.membership_id WHERE i.invoice_id = ?1"
  ).bind(ip.invoice).first();
  if (!inv) return null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO stripe_payments (payment_intent_id, charge_id, invoice_id, user_id, amount_cents, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(paymentIntent, chargeId || null, inv.invoice_id, inv.user_id, ip.amount_paid || 0, svc.nowIso()).run();
  return env.DB.prepare("SELECT * FROM stripe_payments WHERE payment_intent_id = ?1").bind(paymentIntent).first();
}

async function invoiceCredits(env, invoiceId) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS c FROM credit_ledger WHERE idempotency_key = ?1"
  ).bind(`accrual:${invoiceId}`).first();
  return row ? row.c : 0;
}

async function onChargeRefunded(svc, event) {
  const ch = event.data.object;
  const pay = await paymentFor(svc, { paymentIntent: ch.payment_intent, chargeId: ch.id });
  if (!pay) return "ignored";
  const { env } = svc;
  const accrued = await invoiceCredits(env, pay.invoice_id);
  const total = ch.amount || pay.amount_cents || 0;
  if (accrued > 0 && total > 0) {
    // §9.1.4: the invoice's credits × the refunded share, rounded against the house.
    const target = Math.min(accrued, Math.ceil((accrued * (ch.amount_refunded || 0)) / total));
    const done = await env.DB.prepare(
      "SELECT COALESCE(-SUM(amount_cents), 0) AS d FROM credit_ledger WHERE kind = 'refund_reversal' AND ref = ?1"
    ).bind(ch.id).first();
    const delta = target - ((done && done.d) || 0);
    if (delta > 0) {
      const m = await env.DB.prepare("SELECT membership_id FROM membership_invoices WHERE invoice_id = ?1").bind(pay.invoice_id).first();
      await ledgerEntry(env, {
        id: svc.newId(), userId: pay.user_id, membershipId: m && m.membership_id, amountCents: -delta, kind: "refund_reversal",
        ref: ch.id, memo: "Reversed — refund", key: `refund:${ch.id}:${ch.amount_refunded}`, createdAt: svc.nowIso(),
      }).run();
    }
  }
  await runHooks(circleHooks.chargeRefunded, svc, { charge: ch, payment: pay });
  return "processed";
}

async function onDisputeCreated(svc, event) {
  const dp = event.data.object;
  const pay = await paymentFor(svc, { paymentIntent: dp.payment_intent, chargeId: dp.charge });
  if (!pay) return "ignored";
  const { env } = svc;
  const nowIso = svc.nowIso();
  const accrued = await invoiceCredits(env, pay.invoice_id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO stripe_disputes (dispute_id, charge_id, invoice_id, user_id, status, reversed_cents, created_at)
       VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6)`
    ).bind(dp.id, dp.charge || pay.charge_id, pay.invoice_id, pay.user_id, accrued, nowIso),
    ledgerEntry(env, {
      id: svc.newId(), userId: pay.user_id, amountCents: -accrued, kind: "dispute_reversal", ref: dp.id,
      memo: "Reversed — payment dispute", key: `dispute:${dp.id}`, createdAt: nowIso,
    }),
    env.DB.prepare("UPDATE memberships SET credits_frozen = 1, updated_at = ?1 WHERE user_id = ?2").bind(nowIso, pay.user_id),
  ]);
  later(svc, "dispute_suspend", () => membershipSuspended(svc, pay.user_id, "dispute"));
  later(svc, "dispute_mail", () => notifyFelix(svc, {
    dedupeKey: `dispute:${dp.id}`, title: "A payment dispute was opened",
    lines: [`Dispute ${dp.id} on invoice ${pay.invoice_id} (${((dp.amount || 0) / 100).toFixed(2)} USD).`,
      "The member's credits are frozen and the member price is paused until it closes."],
  }));
  await runHooks(circleHooks.dispute, svc, { dispute: dp, payment: pay, opened: true });
  return "processed";
}

async function onDisputeClosed(svc, event) {
  const dp = event.data.object;
  const d = await svc.env.DB.prepare("SELECT * FROM stripe_disputes WHERE dispute_id = ?1").bind(dp.id).first();
  if (!d) return "ignored";
  const { env } = svc;
  const nowIso = svc.nowIso();
  const won = dp.status === "won" || dp.status === "warning_closed";
  const stmts = [env.DB.prepare("UPDATE stripe_disputes SET status = ?1, closed_at = ?2 WHERE dispute_id = ?3")
    .bind(won ? "won" : "lost", nowIso, dp.id)];
  if (won && d.reversed_cents > 0) {
    stmts.push(ledgerEntry(env, {
      id: svc.newId(), userId: d.user_id, amountCents: d.reversed_cents, kind: "dispute_restore", ref: dp.id,
      memo: "Restored — dispute closed in your favour", key: `dispute_won:${dp.id}`, createdAt: nowIso,
    }));
  }
  if (won) {
    stmts.push(env.DB.prepare(
      `UPDATE memberships SET credits_frozen = 0, updated_at = ?1 WHERE user_id = ?2
         AND NOT EXISTS (SELECT 1 FROM stripe_disputes WHERE user_id = ?2 AND status = 'open' AND dispute_id <> ?3)`
    ).bind(nowIso, d.user_id, dp.id));
  }
  await env.DB.batch(stmts);
  if (won) {
    const live = await env.DB.prepare(
      "SELECT 1 AS yes FROM memberships WHERE user_id = ?1 AND status IN ('active','canceling') AND credits_frozen = 0 LIMIT 1"
    ).bind(d.user_id).first();
    if (live) later(svc, "dispute_restore", () => membershipOn(svc, d.user_id));
  }
  await runHooks(circleHooks.dispute, svc, { dispute: dp, opened: false, won });
  return "processed";
}

// ---- "I've updated my card" --------------------------------------------------------------

export async function retryOpenInvoice(svc, userId, idemSuffix) {
  const { env } = svc;
  const open = await env.DB.prepare(
    `SELECT i.invoice_id FROM membership_invoices i JOIN memberships m ON m.id = i.membership_id
      WHERE m.user_id = ?1 AND m.status = 'past_due' AND i.status = 'open' ORDER BY i.created_at DESC LIMIT 1`
  ).bind(userId).first();
  if (!open) return "nothing_to_pay";
  try {
    const inv = await stripeRequest(env, svc.fetch, "POST", `/v1/invoices/${encodeURIComponent(open.invoice_id)}/pay`, {},
      { idempotencyKey: `circle-retry:${open.invoice_id}:${idemSuffix}` });
    return inv && inv.status === "paid" ? "paid" : "pending";
  } catch (e) {
    console.error("invoice retry failed", e && e.code);
    return "declined";
  }
}

async function onPaymentMethodChanged(svc, event) {
  const obj = event.data.object;
  if (event.type === "customer.updated") {
    const prev = (event.data.previous_attributes && event.data.previous_attributes.invoice_settings) || null;
    if (!prev || !("default_payment_method" in prev)) return "ignored";
  }
  const customerId = event.type === "customer.updated" ? obj.id : obj.customer;
  if (!customerId) return "ignored";
  const u = await svc.env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?1").bind(customerId).first();
  if (!u) return "ignored";
  later(svc, "retry", () => retryOpenInvoice(svc, u.id, event.id));
  return "processed";
}

// ---- dispatch --------------------------------------------------------------------------

const HANDLERS = {
  "checkout.session.completed": onSessionCompleted,
  "checkout.session.expired": onSessionExpired,
  "customer.subscription.created": onSubscriptionSnapshot,
  "customer.subscription.updated": onSubscriptionSnapshot,
  "customer.subscription.deleted": onSubscriptionDeleted,
  "invoice.paid": onInvoicePaid,
  "invoice.payment_failed": onInvoicePaymentFailed,
  "invoice.payment_action_required": onInvoiceActionRequired,
  "charge.refunded": onChargeRefunded,
  "charge.dispute.created": onDisputeCreated,
  "charge.dispute.closed": onDisputeClosed,
  "payment_method.attached": onPaymentMethodChanged,
  "customer.updated": onPaymentMethodChanged,
};

export async function processStripeEvent(svc, event) {
  const h = HANDLERS[event.type];
  if (!h || !event.data || !event.data.object) return "ignored";
  return h(svc, event);
}

export { endMembership };
