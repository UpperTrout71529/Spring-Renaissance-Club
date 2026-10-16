// Spending credits (spec v1.1 §8.4 POST /api/credits/redeem, §9.2.4, §16.3
// #5/#6): a fresh step-up, whole credits, an atomic reserve (the redemption
// row and the ledger debit are one D1 batch that only writes when the balance
// covers it), then a single-use Shopify gift card. If Shopify refuses or is
// unreachable the credits come back at once. The full code is in the 201
// response and the email only. "Return to credits" works for an unused card.

import { readJson } from "../http/body.js";
import { HttpError, badRequest, conflict, notFound } from "../http/errors.js";
import { requireStepUp } from "../auth/step-up.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { GiftCardRefused, createCreditCard, creditCardState, deactivateCreditCard } from "../shopify/credit-cards.js";
import { ledgerEntry, balanceCents } from "../circle/ledger.js";
import { spendState } from "../circle/spend.js";
import { emailUser, raiseFlag } from "../circle/notify.js";

const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;
const unavailable = () => new HttpError(503, "credits_unavailable", "We couldn't create your card. Your credits are untouched — please try again.");
const notEnough = () => conflict("insufficient_credits", "You don't have that many credits.");

const shape = (r, code = null) => ({ id: r.id, amount_cents: r.amount_cents, code, last4: r.gift_card_last4 || null, status: r.status });

// Reserves `amount` credits for a new redemption, atomically. Returns the
// redemption id, or null when the balance does not cover it. Throws on a
// duplicate client key (the caller handles that).
export async function reserveCredits(ctx, { userId, amount, clientKey = null, purpose = "credits", capsuleId = null, memo = "Used at checkout" }) {
  const { env } = ctx;
  const id = ctx.newId();
  const nowIso = ctx.nowIso();
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO redemptions (id, user_id, amount_cents, purpose, capsule_id, client_key, status, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'creating', ?7, ?7
        WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_ledger WHERE user_id = ?2) >= ?3`
    ).bind(id, userId, amount, purpose, capsuleId, clientKey, nowIso),
    env.DB.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount_cents, kind, ref, memo, idempotency_key, created_by, created_at)
       SELECT ?1, ?2, ?3, 'redemption', ?4, ?5, ?6, 'system', ?7
        WHERE EXISTS (SELECT 1 FROM redemptions WHERE id = ?4)`
    ).bind(ctx.newId(), userId, -amount, id, memo, `redemption:${id}`, nowIso),
  ]);
  return res[0].meta && res[0].meta.changes === 1 ? id : null;
}

// Issues the card for a reserved redemption; on any failure the credits go back.
export async function issueCard(ctx, { userId, redemptionId, amount, memoPrefix = "Used at checkout" }) {
  const { env } = ctx;
  const customer = await env.DB.prepare("SELECT shopify_customer_id FROM users WHERE id = ?1").bind(userId).first();
  let card;
  try {
    card = await createCreditCard(env, ctx.fetch, { cents: amount, customerId: customer && customer.shopify_customer_id, redemptionId });
  } catch (e) {
    await env.DB.batch([
      ledgerEntry(env, { id: ctx.newId(), userId, amountCents: amount, kind: "redemption_return", ref: redemptionId,
        memo: "Returned — card not created", key: `redemption_return:${redemptionId}`, createdAt: ctx.nowIso() }),
      env.DB.prepare("UPDATE redemptions SET status = 'failed', updated_at = ?1 WHERE id = ?2").bind(ctx.nowIso(), redemptionId),
    ]);
    if (!(e instanceof GiftCardRefused)) {
      // Unreachable or 5xx: Shopify may have made the card anyway.
      await raiseFlag(ctx, {
        kind: "redemption_uncertain", dedupeKey: `redemption_uncertain:${redemptionId}`, userId, ref: redemptionId,
        title: "Check a credits gift card",
        lines: [`Shopify did not answer while creating a gift card for redemption ${redemptionId}; the credits were returned.`,
          `If a card noted "Circle credits · ${redemptionId}" exists in Shopify, deactivate it.`],
      }).catch(() => {});
    }
    console.error("credits card failed", e && e.message);
    throw unavailable();
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE redemptions SET status = 'issued', shopify_gift_card_gid = ?1, gift_card_last4 = ?2, updated_at = ?3 WHERE id = ?4")
      .bind(card.gid, card.last4, ctx.nowIso(), redemptionId),
    env.DB.prepare("UPDATE credit_ledger SET memo = ?1 WHERE idempotency_key = ?2").bind(`${memoPrefix} · card ••${card.last4}`, `redemption:${redemptionId}`),
  ]);
  ctx.waitUntil(emailUser(ctx, userId, "redemption_code", `redemption:${redemptionId}`, { amountCents: amount, code: card.code }));
  return card;
}

export async function postRedeem(ctx) {
  const { env, session } = ctx;
  const user = session.user;
  requireStepUp(ctx);
  const body = await readJson(ctx.request);
  const amount = body.amount_cents;
  if (!Number.isInteger(amount) || amount < 100 || amount % 100 !== 0) {
    throw badRequest("invalid_amount", "Choose a whole number of credits, at least one.");
  }
  const rawKey = ctx.request.headers.get("Idempotency-Key");
  if (rawKey !== null && !KEY_RE.test(rawKey)) throw badRequest("invalid_idempotency_key", "Invalid request key.");
  const clientKey = rawKey ? `${user.id}:${rawKey}` : null;
  const findByKey = () => env.DB.prepare("SELECT * FROM redemptions WHERE client_key = ?1").bind(clientKey).first();
  if (clientKey) {
    const existing = await findByKey();
    if (existing) return ctx.json({ redemption: shape(existing), repeated: true });
  }
  if (!shopifyConfigured(env)) throw unavailable();
  const state = await spendState(env, user.id, ctx.nowIso());
  if (!state.ok) throw new HttpError(state.status, state.code, state.message);
  if (state.balance < amount) throw notEnough();

  let id;
  try {
    id = await reserveCredits(ctx, { userId: user.id, amount, clientKey });
  } catch (e) {
    // The same key racing itself: the other request owns it.
    if (clientKey && /UNIQUE/i.test(String(e && e.message))) {
      const existing = await findByKey();
      if (existing) return ctx.json({ redemption: shape(existing), repeated: true });
    }
    throw e;
  }
  if (!id) throw notEnough();
  const card = await issueCard(ctx, { userId: user.id, redemptionId: id, amount });
  return ctx.json({ redemption: { id, amount_cents: amount, code: card.code, last4: card.last4, status: "issued" } }, 201);
}

export async function postReturn(ctx) {
  const { env, session, params } = ctx;
  const user = session.user;
  const red = await env.DB.prepare("SELECT * FROM redemptions WHERE id = ?1 AND user_id = ?2").bind(params.id, user.id).first();
  if (!red) throw notFound();
  if (red.status !== "issued" || red.purpose !== "credits" || !red.shopify_gift_card_gid) {
    throw conflict("not_returnable", "This card can't go back to credits.");
  }
  const state = await spendState(env, user.id, ctx.nowIso());
  if (!state.ok && state.code !== "balance_negative") throw new HttpError(state.status, state.code, state.message);
  if (!shopifyConfigured(env)) throw unavailable();
  const card = await creditCardState(env, ctx.fetch, red.shopify_gift_card_gid);
  if (!card || !card.enabled) throw conflict("not_returnable", "This card can't go back to credits.");
  if (card.balanceCents !== card.initialCents) throw conflict("card_used", "This card has been used, so it can't go back to credits.");
  await deactivateCreditCard(env, ctx.fetch, red.shopify_gift_card_gid);
  await env.DB.batch([
    ledgerEntry(env, { id: ctx.newId(), userId: user.id, amountCents: red.amount_cents, kind: "redemption_return", ref: red.id,
      memo: `Returned from unused card ••${red.gift_card_last4}`, key: `redemption_return:${red.id}`, createdAt: ctx.nowIso() }),
    env.DB.prepare("UPDATE redemptions SET status = 'deactivated', updated_at = ?1 WHERE id = ?2 AND status = 'issued'").bind(ctx.nowIso(), red.id),
  ]);
  return ctx.json({ returned: true, balance_cents: await balanceCents(env, user.id) });
}

export async function listRedemptions(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, amount_cents, gift_card_last4, status, purpose, created_at FROM redemptions
      WHERE user_id = ?1 AND status IN ('issued','deactivated') ORDER BY created_at DESC LIMIT 50`
  ).bind(ctx.session.user.id).all();
  return ctx.json({
    redemptions: results.map((r) => ({ id: r.id, amount_cents: r.amount_cents, last4: r.gift_card_last4, status: r.status, purpose: r.purpose, created_at: r.created_at })),
  });
}
