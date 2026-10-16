// May this person spend credits now? (spec v1.1 §7 invariants, §16.3 #8/#10/#16)
// — a membership exists; no open dispute (credits_frozen); the balance is not
// below zero; and either a membership is live (active, past_due, canceling) or
// the last one ended and its credits_grace_until has not passed.

import { balanceCents } from "./ledger.js";

export async function spendState(env, userId, nowIso) {
  const { results } = await env.DB.prepare(
    "SELECT status, credits_frozen, credits_grace_until FROM memberships WHERE user_id = ?1 ORDER BY created_at DESC, id DESC"
  ).bind(userId).all();
  if (results.length === 0) return { ok: false, code: "not_a_member", status: 403, message: "Credits are for members of the Circle." };
  if (results.some((m) => m.credits_frozen)) {
    return { ok: false, code: "credits_frozen", status: 409, message: "Your credits are on hold while a payment question is resolved. Contact the concierge." };
  }
  const balance = await balanceCents(env, userId);
  if (balance < 0) {
    return { ok: false, code: "balance_negative", status: 409, message: "Your credit balance is below zero after a refund. Contact the concierge." };
  }
  const live = results.some((m) => ["active", "past_due", "canceling"].includes(m.status));
  const inGrace = results.some((m) => m.status === "ended" && m.credits_grace_until && m.credits_grace_until > nowIso);
  if (!live && !inGrace) return { ok: false, code: "credits_expired", status: 409, message: "These credits have expired." };
  return { ok: true, balance };
}
