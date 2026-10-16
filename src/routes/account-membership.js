// Account → Membership & billing (spec v1.1 §6.8, §8.4; docs/tz-v2-circle.md
// §3.1): plan, next charge (Stripe's preview invoice, so the amount includes
// tax), invoices with their receipts, and a Stripe Customer Portal link for the
// card (the portal is set to card + invoices only — cancel lives here).

import { HttpError, forbidden } from "../http/errors.js";
import { stripeConfigured, stripeRequest, StripeError } from "../stripe/client.js";
import { loadSettings } from "../circle/economics-store.js";
import { currentMembership } from "./circle-member.js";
import { portalUrl } from "./auth.js";

const PREVIEW_TTL_S = 6 * 60 * 60;
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

async function nextCharge(ctx, m) {
  const { env } = ctx;
  if (m.status !== "active" || !m.current_period_end || !stripeConfigured(env)) return null;
  const key = `circle_preview:${m.stripe_subscription_id}:${day(m.current_period_end)}`;
  const hit = env.CLIENT_KV ? await env.CLIENT_KV.get(key, { type: "json" }).catch(() => null) : null;
  if (hit) return hit;
  try {
    const inv = await stripeRequest(env, ctx.fetch, "POST", "/v1/invoices/create_preview",
      { customer: m.stripe_customer_id || undefined, subscription: m.stripe_subscription_id });
    const out = { date: day(m.current_period_end), amount_cents: inv.amount_due };
    if (env.CLIENT_KV) await env.CLIENT_KV.put(key, JSON.stringify(out), { expirationTtl: PREVIEW_TTL_S }).catch(() => {});
    return out;
  } catch (e) {
    console.error("preview invoice failed", e && e.code);
    return null;
  }
}

export async function getMembershipBilling(ctx) {
  const { env, session, json } = ctx;
  const m = await currentMembership(env, session.user.id);
  if (!m) throw forbidden("not_a_member", "There is no membership on this account.");
  const { settings } = await loadSettings(env);
  const { results } = await env.DB.prepare(
    `SELECT i.period_start, i.amount_paid_cents, i.status, i.hosted_invoice_url FROM membership_invoices i
       JOIN memberships m ON m.id = i.membership_id WHERE m.user_id = ?1 ORDER BY i.period_start DESC LIMIT 24`
  ).bind(session.user.id).all();
  return json({
    status: m.status,
    kind: m.kind,
    since: m.started_at,
    monthly_cents: settings.monthly_cents,
    current_period_end: day(m.current_period_end),
    ends_on: m.status === "canceling" ? day(m.current_period_end) : day(m.ended_at),
    credits_grace_until: day(m.credits_grace_until),
    next_charge: await nextCharge(ctx, m),
    invoices: results.map((i) => ({ date: day(i.period_start), amount_paid_cents: i.amount_paid_cents, status: i.status, url: i.hosted_invoice_url })),
  });
}

export async function postBillingPortal(ctx) {
  const { env, session, json } = ctx;
  const m = await currentMembership(env, session.user.id);
  if (!m || !m.stripe_customer_id) throw forbidden("not_a_member", "There is no membership on this account.");
  try {
    const s = await stripeRequest(env, ctx.fetch, "POST", "/v1/billing_portal/sessions",
      { customer: m.stripe_customer_id, return_url: `${portalUrl(env)}/account/membership` });
    return json({ url: s.url });
  } catch (e) {
    if (e instanceof StripeError) throw new HttpError(503, "billing_unavailable", "Billing is unavailable for a moment. Please try again.");
    throw e;
  }
}
