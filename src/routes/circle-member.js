// The member's Circle (spec v1.1 §6.7, §8.4; docs/tz-v2-circle.md §3.1, §5.1):
// GET /api/circle — one call for the member page; GET /api/circle/credits —
// the treasury and its history, 20 rows a page, newest first, with the
// running balance. No Stripe or Shopify ids leave the server.

import { badRequest, forbidden } from "../http/errors.js";
import { balanceCents } from "../circle/ledger.js";

const PAGE = 20;
const LIVE = ["active", "past_due", "canceling"];

// Later tasks add sections: (ctx, { membership, userId }) → { key, value }.
export const memberSections = [];

export async function currentMembership(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM memberships WHERE user_id = ?1 ORDER BY created_at DESC, id DESC"
  ).bind(userId).all();
  return results.find((m) => LIVE.includes(m.status)) || results[0] || null;
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

function publicMembership(m) {
  if (!m) return null;
  return {
    status: m.status,
    kind: m.kind,
    since: m.started_at,
    current_period_end: m.current_period_end,
    ends_on: m.status === "canceling" ? day(m.current_period_end) : m.ended_at ? day(m.ended_at) : null,
    end_reason: m.end_reason,
    credits_grace_until: day(m.credits_grace_until),
    // Until when credits stay usable: canceling → period end + 30 days
    // (the same rule the cancel flow states), ended → the grace date.
    credits_until: m.status === "canceling" && m.current_period_end
      ? day(new Date(Date.parse(m.current_period_end) + 30 * 24 * 60 * 60 * 1000).toISOString())
      : m.status === "ended" ? day(m.credits_grace_until) : null,
    paid_months: m.paid_invoices,
  };
}

function treasury(m, balance, frozen, monthlyCents = 2000) {
  return {
    balance_cents: balance,
    next_accrual: m && m.status === "active" && m.current_period_end ? { date: day(m.current_period_end), amount_cents: monthlyCents } : null,
    expires_on: m && m.status === "ended" ? day(m.credits_grace_until) : null,
    frozen,
  };
}

async function frozenFor(env, userId) {
  const row = await env.DB.prepare("SELECT 1 AS yes FROM memberships WHERE user_id = ?1 AND credits_frozen = 1 LIMIT 1").bind(userId).first();
  return !!row;
}

export async function getCircle(ctx) {
  const { env, session, json } = ctx;
  const userId = session.user.id;
  const m = await currentMembership(env, userId);
  if (!m) return json({ membership: null });
  const balance = await balanceCents(env, userId);
  const gift = await env.DB.prepare(
    "SELECT status FROM gift_selections WHERE user_id = ?1 AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first();
  const out = {
    membership: publicMembership(m),
    ...treasury(m, balance, await frozenFor(env, userId)),
    welcome: gift ? { status: gift.status } : null,
  };
  for (const section of memberSections) {
    try {
      const s = await section(ctx, { membership: m, userId });
      if (s) out[s.key] = s.value;
    } catch (e) {
      console.error("circle section failed", e && e.message);
    }
  }
  return json(out);
}

const encodeCursor = (c) => btoa(JSON.stringify(c)).replace(/=+$/, "");
function decodeCursor(raw) {
  try {
    const v = JSON.parse(atob(raw));
    if (Array.isArray(v) && typeof v[0] === "string" && Number.isInteger(v[1])) return v;
  } catch { /* fall through */ }
  throw badRequest("invalid_cursor", "That page link is not valid.");
}

export async function getCredits(ctx) {
  const { env, session, url, json } = ctx;
  const userId = session.user.id;
  const m = await currentMembership(env, userId);
  if (!m) throw forbidden("not_a_member", "Credits are for members of the Circle.");
  const balance = await balanceCents(env, userId);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  let newer = 0;
  let rows;
  if (cursor) {
    const n = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM credit_ledger WHERE user_id = ?1
         AND (created_at > ?2 OR (created_at = ?2 AND rowid >= ?3))`
    ).bind(userId, cursor[0], cursor[1]).first();
    newer = n.s;
    rows = (await env.DB.prepare(
      `SELECT rowid AS rid, created_at, memo, amount_cents, kind FROM credit_ledger WHERE user_id = ?1
         AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
       ORDER BY created_at DESC, rowid DESC LIMIT ?4`
    ).bind(userId, cursor[0], cursor[1], PAGE + 1).all()).results;
  } else {
    rows = (await env.DB.prepare(
      `SELECT rowid AS rid, created_at, memo, amount_cents, kind FROM credit_ledger WHERE user_id = ?1
       ORDER BY created_at DESC, rowid DESC LIMIT ?2`
    ).bind(userId, PAGE + 1).all()).results;
  }
  const page = rows.slice(0, PAGE);
  let running = balance - newer;
  const ledger = page.map((r) => {
    const row = { date: r.created_at, memo: r.memo, amount_cents: r.amount_cents, kind: r.kind, running_balance_cents: running };
    running -= r.amount_cents;
    return row;
  });
  const last = page.at(-1);
  return json({
    ...treasury(m, balance, await frozenFor(env, userId)),
    ledger,
    next_cursor: rows.length > PAGE && last ? encodeCursor([last.created_at, last.rid]) : null,
  });
}
