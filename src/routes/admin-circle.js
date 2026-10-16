// Admin: Circle overview, credit adjustments, flags (spec v1.1 §8.6, §12,
// §15.2; tz-v2 §3.3). "Credits outstanding" is the ledger sum (§15.2).

import { readJson } from "../http/body.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { ledgerEntry, balanceCents } from "../circle/ledger.js";
import { loadSettings } from "../circle/economics-store.js";
import { syncMemberPrice } from "../circle/member-price.js";

async function audit(ctx, action, target, payload = null) {
  await ctx.env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(ctx.newId(), ctx.admin.email, action, target, payload ? JSON.stringify(payload) : null, ctx.nowIso()).run();
}

export async function adjustCredits(ctx) {
  const { env } = ctx;
  const b = await readJson(ctx.request);
  const memo = typeof b.memo === "string" ? b.memo.trim().slice(0, 200) : "";
  if (!memo) throw badRequest("note_required", "A note is required for every adjustment.");
  if (!Number.isInteger(b.amount_cents) || b.amount_cents === 0 || b.amount_cents % 100 !== 0 || Math.abs(b.amount_cents) > 1000000) {
    throw badRequest("invalid_amount", "Whole credits, plus or minus.");
  }
  const m = await env.DB.prepare("SELECT id FROM memberships WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(b.user_id).first();
  if (!m) throw conflict("not_a_member", "Only members have credits.");
  // Review finding 13: a double submit with the same key is booked once.
  const raw = ctx.request.headers.get("Idempotency-Key");
  if (raw !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(raw)) throw badRequest("invalid_idempotency_key", "Invalid request key.");
  const key = raw ? `manual:key:${b.user_id}:${raw}` : null;
  if (key) {
    const seen = await env.DB.prepare("SELECT 1 AS yes FROM credit_ledger WHERE idempotency_key = ?1").bind(key).first();
    if (seen) return ctx.json({ balance_cents: await balanceCents(env, b.user_id), repeated: true });
  }
  const balance = await balanceCents(env, b.user_id);
  if (balance + b.amount_cents < 0) throw conflict("below_zero", "An adjustment cannot take the balance below zero.");
  const id = ctx.newId();
  await ledgerEntry(env, {
    id, userId: b.user_id, membershipId: m.id, amountCents: b.amount_cents, kind: "manual", ref: id,
    memo: `Adjustment by the Maison — ${memo}`, key: key || `manual:${id}`, createdBy: `admin:${ctx.admin.email}`, createdAt: ctx.nowIso(),
  }).run();
  await audit(ctx, "credits_adjusted", b.user_id, { amount_cents: b.amount_cents, memo });
  return ctx.json({ balance_cents: balance + b.amount_cents }, 201);
}

// Review finding 6: after a lost dispute (or any freeze) Felix decides.
export async function unfreezeCredits(ctx) {
  const { env, params } = ctx;
  const b = await readJson(ctx.request);
  const memo = typeof b.memo === "string" ? b.memo.trim().slice(0, 200) : "";
  if (!memo) throw badRequest("note_required", "A note is required.");
  const res = await env.DB.prepare("UPDATE memberships SET credits_frozen = 0, updated_at = ?1 WHERE user_id = ?2 AND credits_frozen = 1")
    .bind(ctx.nowIso(), params.id).run();
  if (!res.meta || res.meta.changes === 0) throw conflict("not_frozen", "These credits are not frozen.");
  await audit(ctx, "credits_unfrozen", params.id, { memo });
  ctx.waitUntil(syncMemberPrice(ctx));
  return ctx.json({ unfrozen: true });
}

export async function circleOverview(ctx) {
  const { env, json } = ctx;
  const counts = (await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM memberships m WHERE m.created_at = (SELECT MAX(x.created_at) FROM memberships x WHERE x.user_id = m.user_id)
      GROUP BY status`
  ).all()).results;
  const members = { pending: 0, active: 0, past_due: 0, canceling: 0, ended: 0, ended_expired: 0 };
  for (const c of counts) members[c.status] = c.n;
  const out = await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM credit_ledger").first();
  const flags = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_flags WHERE status = 'open'").first();
  const welcome = await env.DB.prepare("SELECT COUNT(*) AS n FROM gift_selections WHERE status IN ('awaiting_choice','chosen')").first();
  const review = await env.DB.prepare("SELECT COUNT(*) AS n FROM referrals WHERE status = 'review'").first();
  const { settings } = await loadSettings(env);
  return json({
    members,
    credits_outstanding_cents: out.s,
    monthly_recurring_cents: (members.active + members.canceling + members.past_due) * settings.monthly_cents,
    open_flags: flags.n,
    welcome_queue: welcome.n,
    invitations_to_review: review.n,
  });
}

export async function listFlags(ctx) {
  const status = ctx.url.searchParams.get("status") === "resolved" ? "resolved" : "open";
  const { results } = await ctx.env.DB.prepare(
    `SELECT f.id, f.kind, f.ref, f.details_json, f.status, f.created_at, f.resolved_at, f.resolved_by, u.email
       FROM admin_flags f LEFT JOIN users u ON u.id = f.user_id WHERE f.status = ?1 ORDER BY f.created_at DESC LIMIT 200`
  ).bind(status).all();
  return ctx.json({ flags: results });
}

export async function resolveFlag(ctx) {
  const res = await ctx.env.DB.prepare(
    "UPDATE admin_flags SET status = 'resolved', resolved_at = ?1, resolved_by = ?2 WHERE id = ?3 AND status = 'open'"
  ).bind(ctx.nowIso(), ctx.admin.email, ctx.params.id).run();
  if (!res.meta || res.meta.changes !== 1) throw notFound();
  await audit(ctx, "flag_resolved", ctx.params.id);
  return ctx.json({ resolved: true });
}
