// The credit ledger (spec v1.1 §7): append-only; balance = SUM(amount_cents);
// every row has a unique idempotency key, so a repeated webhook or click never
// writes twice. 1 credit = 100 cents.

export async function balanceCents(env, userId) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS b FROM credit_ledger WHERE user_id = ?1")
    .bind(userId).first();
  return row ? row.b : 0;
}

// A prepared INSERT OR IGNORE — put it in a batch with the state it belongs to.
export function ledgerEntry(env, { id, userId, membershipId = null, amountCents, kind, ref = null, memo = null, key, createdBy = "system", createdAt }) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger (id, user_id, membership_id, amount_cents, kind, ref, memo, idempotency_key, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(id, userId, membershipId, amountCents, kind, ref, memo, key, createdBy, createdAt);
}

export function monthName(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}
