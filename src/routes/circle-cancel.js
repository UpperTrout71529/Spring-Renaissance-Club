// Cancelling, undoing and keeping a membership (spec v1.1 §16.1, §16.3 #9;
// docs/tz-v2-circle.md §3.1) and "I've updated my card" (§9.1.4).
// Three screens at most, no step-up (§14.2: cancelling must be as easy as
// joining), one non-monetary offer by reason, the cancel button always there.

import { readJson } from "../http/body.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../http/errors.js";
import { stripeRequest, StripeError } from "../stripe/client.js";
import { balanceCents } from "../circle/ledger.js";
import { emailUser } from "../circle/notify.js";
import { retryOpenInvoice, GRACE_DAYS } from "../circle/stripe-events.js";
import { currentMembership } from "./circle-member.js";

const REASONS = ["spending_less", "not_finding_pieces", "too_many_credits", "order_issue", "plans_changed", "other"];
const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso) => String(iso).slice(0, 10);
const plusDays = (iso, n) => new Date(Date.parse(iso) + n * DAY_MS).toISOString();
const unavailable = () => new HttpError(503, "cancel_unavailable", "We couldn't reach our payment provider. Please try again in a moment.");

function offerFor(reason, balance) {
  const credits = Math.floor(balance / 100);
  switch (reason) {
    case "not_finding_pieces":
      return { kind: "concierge", copy: "Write to the concierge — we'll suggest pieces for your rooms." };
    case "too_many_credits":
      // Credits are a gift card at checkout; Shopify does not let a gift card buy
      // another gift card, so the spec's "gift cards for friends" is left out.
      return { kind: "use_credits", copy: `You have ${credits} ${credits === 1 ? "credit" : "credits"}. They also work on Small Pleasures.` };
    case "order_issue":
      return { kind: "concierge_priority", copy: "We'd like to make this right." };
    default:
      return null;
  }
}

function datesFor(m, nowIso) {
  if (m.status === "past_due") {
    // §16.3 #9: the subscription ends now; credits run from the last paid period.
    const base = m.last_paid_period_end || nowIso;
    return { endsOn: day(nowIso), creditsUntil: day(plusDays(base, GRACE_DAYS)) };
  }
  const end = m.current_period_end || nowIso;
  return { endsOn: day(end), creditsUntil: day(plusDays(end, GRACE_DAYS)) };
}

async function liveOrThrow(ctx) {
  const m = await currentMembership(ctx.env, ctx.session.user.id);
  if (!m || !["active", "past_due", "canceling"].includes(m.status)) throw forbidden("not_a_member", "There is no membership to cancel.");
  return m;
}

export async function cancelStart(ctx) {
  const { env, session } = ctx;
  const body = await readJson(ctx.request);
  if (!REASONS.includes(body.reason)) throw badRequest("invalid_reason", "Please choose a reason.");
  const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 500) || null : null;
  const m = await liveOrThrow(ctx);
  if (m.status === "canceling") throw conflict("already_canceling", "Your membership is already set to end.");
  const balance = await balanceCents(env, session.user.id);
  const offer = offerFor(body.reason, balance);
  const { endsOn, creditsUntil } = datesFor(m, ctx.nowIso());
  const id = ctx.newId();
  await env.DB.prepare(
    `INSERT INTO cancellations (id, membership_id, reason, comment, offer_shown, offer_accepted, outcome, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, 'abandoned', ?6, ?6)`
  ).bind(id, m.id, body.reason, comment, offer ? offer.kind : null, ctx.nowIso()).run();
  return ctx.json({ cancellation_id: id, offer, ends_on: endsOn, credits_until: creditsUntil, balance_cents: Math.max(0, balance) }, 201);
}

async function ownCancellation(ctx, id) {
  if (typeof id !== "string") throw badRequest("invalid_request", "Missing cancellation.");
  const row = await ctx.env.DB.prepare(
    `SELECT c.*, m.user_id FROM cancellations c JOIN memberships m ON m.id = c.membership_id WHERE c.id = ?1 AND m.user_id = ?2`
  ).bind(id, ctx.session.user.id).first();
  if (!row) throw notFound();
  if (row.outcome !== "abandoned") throw conflict("cancellation_closed", "This cancellation has already been answered.");
  return row;
}

export async function cancelConfirm(ctx) {
  const { env, session } = ctx;
  const body = await readJson(ctx.request);
  const c = await ownCancellation(ctx, body.cancellation_id);
  const m = await liveOrThrow(ctx);
  if (m.id !== c.membership_id) throw conflict("cancellation_closed", "This cancellation belongs to an earlier membership.");
  if (m.status === "canceling") throw conflict("already_canceling", "Your membership is already set to end.");
  const { endsOn, creditsUntil } = datesFor(m, ctx.nowIso());
  try {
    if (m.status === "past_due") {
      await stripeRequest(env, ctx.fetch, "DELETE", `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`, {},
        { idempotencyKey: `circle-cancel:${c.id}` });
    } else {
      await stripeRequest(env, ctx.fetch, "POST", `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`,
        { cancel_at_period_end: true }, { idempotencyKey: `circle-cancel:${c.id}` });
    }
  } catch (e) {
    if (e instanceof StripeError) {
      console.error("cancel failed", e.status, e.code);
      throw unavailable();
    }
    throw e;
  }
  const nowIso = ctx.nowIso();
  const stmts = [env.DB.prepare("UPDATE cancellations SET outcome = 'canceled', updated_at = ?1 WHERE id = ?2").bind(nowIso, c.id)];
  if (m.status === "active") {
    stmts.push(env.DB.prepare(
      "UPDATE memberships SET status = 'canceling', cancel_requested_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'"
    ).bind(nowIso, m.id));
  }
  await env.DB.batch(stmts);
  if (m.status === "active") {
    const balance = await balanceCents(env, session.user.id);
    ctx.waitUntil(emailUser(ctx, session.user.id, "membership_canceled", `membership_canceled:${m.id}:${c.id}`,
      { endsOn, graceUntil: creditsUntil, balanceCents: Math.max(0, balance) }));
  }
  return ctx.json({ ends_on: endsOn, credits_until: creditsUntil });
}

export async function cancelUndo(ctx) {
  const { env } = ctx;
  const m = await liveOrThrow(ctx);
  if (m.status !== "canceling") throw conflict("not_canceling", "Your membership is not set to end.");
  try {
    await stripeRequest(env, ctx.fetch, "POST", `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`,
      { cancel_at_period_end: false }, { idempotencyKey: `circle-undo:${m.id}:${m.cancel_requested_at}` });
  } catch (e) {
    if (e instanceof StripeError) throw unavailable();
    throw e;
  }
  const nowIso = ctx.nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE memberships SET status = 'active', cancel_requested_at = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'canceling'")
      .bind(nowIso, m.id),
    env.DB.prepare(
      `UPDATE cancellations SET outcome = 'saved', updated_at = ?1 WHERE id = (
         SELECT id FROM cancellations WHERE membership_id = ?2 AND outcome = 'canceled' ORDER BY created_at DESC LIMIT 1)`
    ).bind(nowIso, m.id),
  ]);
  return ctx.json({ status: "active" });
}

export async function cancelKeep(ctx) {
  const body = await readJson(ctx.request);
  const c = await ownCancellation(ctx, body.cancellation_id);
  await ctx.env.DB.prepare("UPDATE cancellations SET outcome = 'saved', offer_accepted = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(body.offer_accepted === true ? 1 : 0, ctx.nowIso(), c.id).run();
  return ctx.json({ kept: true });
}

export async function billingRetry(ctx) {
  const m = await liveOrThrow(ctx);
  if (m.status !== "past_due") return ctx.json({ result: "nothing_to_pay" });
  const result = await retryOpenInvoice(ctx, ctx.session.user.id, `manual:${ctx.now()}`);
  return ctx.json({ result });
}
