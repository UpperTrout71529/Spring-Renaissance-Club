// Joining the Circle (spec v1.1 §9.1.2, §14.2, §16.3; docs/tz-v2-circle.md
// §3.1, §5.1). GET /api/circle/join says whether this person can join or
// rejoin now and on which terms; POST /api/circle/checkout (first join, $50)
// and POST /api/circle/rejoin ($20, no joining fee, no welcome piece) record
// the consents and open Stripe Checkout. The membership itself is created
// only by the Stripe webhook.

import { readJson } from "../http/body.js";
import { badRequest, conflict, HttpError } from "../http/errors.js";
import { stripeConfigured, stripeRequest, StripeError } from "../stripe/client.js";
import { resolvePrices } from "../stripe/catalog.js";
import { loadSettings } from "../circle/economics-store.js";
import { shippingFor } from "../circle/economics.js";
import { CONSENT_TEXTS, REGION_NOTE, TERMS_VERSION, addMonthsIso, disclosure } from "../circle/terms.js";
import { hasPastMembership, liveMembership } from "../circle/membership.js";
import { summarizeUserAgent } from "../auth/session.js";
import { sha256Hex } from "../lib/crypto.js";
import { portalUrl } from "./auth.js";

// Set by T17 (invitations): (ctx, user, code) → { referral_id, coupon_id, discount_cents } | null.
export const invitations = { forCheckout: null, describe: null };

const paymentUnavailable = () =>
  new HttpError(503, "payment_unavailable", "Payments are unavailable for a moment. Please try again shortly.");

// §16.3 #27: without at least two welcome pieces there is no choice, so no join.
async function welcomeSetReady(env, settings) {
  const { results } = await env.DB.prepare(
    "SELECT landed_cost_cents, shipping_class FROM gift_options WHERE kind = 'welcome' AND active = 1"
  ).all();
  const ok = results.filter((g) => {
    const ship = shippingFor(g.shipping_class, settings);
    return ship && Number.isInteger(g.landed_cost_cents) && g.landed_cost_cents + ship.cents <= settings.welcome_cap_cents;
  });
  return ok.length >= 2;
}

async function offerFor(ctx, { invitation = null } = {}) {
  const { env } = ctx;
  const user = ctx.session.user;
  const live = await liveMembership(env, user.id);
  const kind = live ? "member" : (await hasPastMembership(env, user.id)) ? "rejoin" : "join";
  const base = {
    kind,
    terms_version: TERMS_VERSION,
    terms_url: `${portalUrl(env)}/terms/membership`,
    consents: [{ id: "terms", text: CONSENT_TEXTS.terms }, { id: "age_18", text: CONSENT_TEXTS.age_18 }],
    region_note: REGION_NOTE,
  };
  const closed = (reason) => ({ ...base, open: false, reason });
  if (kind === "member") return closed("already_member");
  if (!stripeConfigured(env)) return closed("not_configured");
  if (env.CIRCLE_JOIN_OPEN !== "on") return closed("not_open");
  const { settings } = await loadSettings(env);
  if (kind === "join" && !(await welcomeSetReady(env, settings))) return closed("welcome_set_incomplete");

  let prices;
  try {
    prices = await resolvePrices(env, ctx.fetch, ctx.now());
  } catch (e) {
    console.error("circle prices unavailable", e && e.code);
    return closed("not_configured");
  }
  // The economics assume these amounts; Stripe must charge exactly them.
  if (prices.monthly.unit_amount !== settings.monthly_cents || prices.joining.unit_amount !== settings.joining_cents) {
    return closed("price_mismatch");
  }
  const discount = kind === "join" && invitation ? invitation.discount_cents : 0;
  const first = kind === "join" ? settings.monthly_cents + settings.joining_cents - discount : settings.monthly_cents;
  const firstRenewalOn = addMonthsIso(ctx.now(), 1);
  return {
    ...base,
    open: true,
    reason: null,
    first_charge_cents: first,
    monthly_cents: settings.monthly_cents,
    joining_cents: kind === "join" ? settings.joining_cents : 0,
    discount_cents: discount,
    first_renewal_on: firstRenewalOn,
    disclosure: disclosure({ firstChargeCents: first, monthlyCents: settings.monthly_cents, firstRenewalOn, rejoin: kind === "rejoin" }),
    _prices: prices,
  };
}

const publicOffer = ({ _prices, ...rest }) => rest;

// GET /api/circle/join[?invite=CODE]
export async function getJoin(ctx) {
  const code = ctx.url.searchParams.get("invite");
  let invitation = null;
  let invitationNote = null;
  if (code && invitations.describe) ({ invitation, note: invitationNote } = await invitations.describe(ctx, ctx.session.user, code));
  const offer = await offerFor(ctx, { invitation });
  return ctx.json({ ...publicOffer(offer), invitation_note: invitationNote });
}

async function ensureCustomer(ctx, user) {
  const { env } = ctx;
  const row = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?1").bind(user.id).first();
  if (row && row.stripe_customer_id) return row.stripe_customer_id;
  const customer = await stripeRequest(env, ctx.fetch, "POST", "/v1/customers",
    { email: user.email, metadata: { user_id: user.id } }, { idempotencyKey: `circle-customer:${user.id}` });
  await env.DB.prepare("UPDATE users SET stripe_customer_id = ?1 WHERE id = ?2 AND stripe_customer_id IS NULL")
    .bind(customer.id, user.id).run();
  const after = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?1").bind(user.id).first();
  return after.stripe_customer_id;
}

async function recordConsents(ctx, user, offer) {
  const { env } = ctx;
  const ua = summarizeUserAgent(ctx.request.headers.get("User-Agent"));
  const termsHash = await sha256Hex(`${CONSENT_TEXTS.terms}\n${offer.disclosure}`);
  const ageHash = await sha256Hex(CONSENT_TEXTS.age_18);
  const ins = env.DB.prepare(
    `INSERT INTO consents (id, user_id, kind, document_version, shown_text_sha256, granted, ua_summary, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)`
  );
  const nowIso = ctx.nowIso();
  await env.DB.batch([
    ins.bind(ctx.newId() + "T", user.id, "membership_terms", TERMS_VERSION, termsHash, ua, nowIso),
    ins.bind(ctx.newId() + "R", user.id, "auto_renewal", TERMS_VERSION, termsHash, ua, nowIso),
    ins.bind(ctx.newId() + "A", user.id, "age_18", TERMS_VERSION, ageHash, ua, nowIso),
  ]);
}

async function startCheckout(ctx, mode) {
  const { env } = ctx;
  const user = ctx.session.user;
  const body = await readJson(ctx.request);
  const c = body.consents || {};
  if (c.terms !== true || c.age_18 !== true) throw badRequest("consent_required", "Please confirm both statements to continue.");
  if (body.terms_version !== TERMS_VERSION) throw conflict("terms_changed", "The Membership Terms have changed. Please review them again.");

  if (await liveMembership(env, user.id)) throw conflict("already_member", "You're already a member of the Circle.");
  const past = await hasPastMembership(env, user.id);
  if (mode === "join" && past) throw conflict("use_rejoin", "Welcome back — you can rejoin from your Circle page.");
  if (mode === "rejoin" && !past) throw conflict("not_a_former_member", "Rejoining is for former members.");

  let invitation = null;
  if (mode === "join" && typeof body.invite_code === "string" && invitations.forCheckout) {
    invitation = await invitations.forCheckout(ctx, user, body.invite_code);
  }
  const offer = await offerFor(ctx, { invitation });
  if (!offer.open) throw conflict("circle_not_open", "The Circle is not open for joining yet.");

  await recordConsents(ctx, user, offer);
  const prices = offer._prices;
  const portal = portalUrl(env);
  const taxOn = env.STRIPE_TAX_ENABLED === "true";
  const meta = { user_id: user.id, kind: mode, terms_version: TERMS_VERSION, referral_id: invitation ? invitation.referral_id : undefined };
  const variant = invitation ? `join-invite-${invitation.referral_id}` : mode;
  try {
    const customer = await ensureCustomer(ctx, user);
    const session = await stripeRequest(env, ctx.fetch, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: mode === "join"
        ? [{ price: prices.monthly.id, quantity: 1 }, { price: prices.joining.id, quantity: 1 }]
        : [{ price: prices.monthly.id, quantity: 1 }],
      discounts: invitation ? [{ coupon: invitation.coupon_id }] : undefined,
      automatic_tax: { enabled: taxOn },
      customer_update: taxOn ? { address: "auto", shipping: "auto" } : undefined,
      billing_address_collection: "required",
      shipping_address_collection: { allowed_countries: ["US"] },
      consent_collection: env.STRIPE_CHECKOUT_TOS === "on" ? { terms_of_service: "required" } : undefined,
      custom_text: { submit: { message: offer.disclosure } },
      subscription_data: { metadata: meta },
      metadata: meta,
      success_url: `${portal}/circle/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${portal}/circle?checkout=canceled`,
    }, { idempotencyKey: `circle-checkout:${user.id}:${ctx.nowIso().slice(0, 10)}:${variant}` });
    return ctx.json({ url: session.url }, 201);
  } catch (e) {
    if (e instanceof StripeError) {
      console.error("checkout failed", e.status, e.code);
      throw paymentUnavailable();
    }
    throw e;
  }
}

export const postCheckout = (ctx) => startCheckout(ctx, "join");
export const postRejoin = (ctx) => startCheckout(ctx, "rejoin");
