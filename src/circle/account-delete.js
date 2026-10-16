// Deleting an account that has a Circle membership (spec v1.1 §13.4, §16.3
// #12; docs/tz-v2-circle.md §4 delete additions). Stripe first and fail
// closed: if the subscription cannot be cancelled, nothing local changes and
// the account is not deleted. Then the membership ends now (account_deleted),
// the credits expire, and Circle rows that hold an address are closed.

import { HttpError } from "../http/errors.js";
import { stripeRequest, StripeError, stripeConfigured } from "../stripe/client.js";
import { balanceCents, ledgerEntry } from "./ledger.js";
import { membershipOff } from "./effects.js";

const LIVE = ["pending", "active", "past_due", "canceling"];

// Later tasks add their own closing statements: (env, userId, nowIso) → [stmt].
export const deletionClosers = [];

export async function closeCircleForDeletion(ctx, userId) {
  const { env } = ctx;
  const { results } = await env.DB.prepare("SELECT * FROM memberships WHERE user_id = ?1").bind(userId).all();
  if (results.length === 0) return false;
  const live = results.filter((m) => LIVE.includes(m.status) && m.stripe_subscription_id);
  for (const m of live) {
    if (!stripeConfigured(env)) throw new HttpError(503, "membership_cancel_failed", "We couldn't end your membership right now, so your account was not deleted. Please try again shortly.");
    try {
      await stripeRequest(env, ctx.fetch, "DELETE", `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`, {},
        { idempotencyKey: `circle-delete:${m.id}` });
    } catch (e) {
      if (e instanceof StripeError && e.code === "resource_missing") continue; // already gone in Stripe
      console.error("delete: subscription cancel failed", e && e.code);
      throw new HttpError(503, "membership_cancel_failed", "We couldn't end your membership right now, so your account was not deleted. Please try again shortly.");
    }
  }
  const nowIso = ctx.nowIso();
  const balance = await balanceCents(env, userId);
  const stmts = [
    env.DB.prepare(
      `UPDATE memberships SET status = 'ended', end_reason = 'account_deleted', ended_at = COALESCE(ended_at, ?1),
         credits_grace_until = ?1, updated_at = ?1 WHERE user_id = ?2 AND status IN ('pending','active','past_due','canceling')`
    ).bind(nowIso, userId),
    env.DB.prepare("UPDATE memberships SET status = 'ended_expired', updated_at = ?1 WHERE user_id = ?2 AND status = 'ended'").bind(nowIso, userId),
    env.DB.prepare(
      "UPDATE gift_selections SET status = CASE WHEN status IN ('awaiting_choice','chosen') THEN 'canceled' ELSE status END, shipping_json = NULL, updated_at = ?1 WHERE user_id = ?2"
    ).bind(nowIso, userId),
    env.DB.prepare(
      "UPDATE anniversary_gifts SET status = CASE WHEN status IN ('awaiting_address','ready') THEN 'canceled' ELSE status END, shipping_json = NULL, updated_at = ?1 WHERE user_id = ?2"
    ).bind(nowIso, userId),
  ];
  if (balance > 0) {
    stmts.push(ledgerEntry(env, { id: ctx.newId(), userId, amountCents: -balance, kind: "expiry", memo: "Expired — account deleted",
      key: `expiry:account_deleted:${userId}`, createdAt: nowIso }));
  }
  for (const closer of deletionClosers) stmts.push(...(await closer(env, userId, nowIso, ctx.fetch)));
  await env.DB.batch(stmts);
  if (live.length) ctx.waitUntil(membershipOff(ctx, userId, "account_deleted"));
  return true;
}
