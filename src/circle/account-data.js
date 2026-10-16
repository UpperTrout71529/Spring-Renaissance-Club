// The Circle's part of "Download my data" and "Delete my account"
// (spec v1.1 §13.3, §13.4). Export: membership, invoices, credits, choices,
// invitations, concierge messages, room photo labels. Deletion: concierge
// messages and room photos (R2 files too) are erased; open object claims are
// cancelled; referral rows stay without personal data (the user row is
// anonymised by the account code).

export async function circleExport(env, userId) {
  const all = async (sql) => (await env.DB.prepare(sql).bind(userId).all()).results;
  const memberships = await all(
    "SELECT kind, status, started_at, current_period_end, ended_at, end_reason, credits_grace_until, paid_invoices FROM memberships WHERE user_id = ?1 ORDER BY created_at");
  if (memberships.length === 0) return null;
  return {
    memberships,
    invoices: await all(`SELECT i.period_start, i.period_end, i.amount_paid_cents, i.status FROM membership_invoices i
      JOIN memberships m ON m.id = i.membership_id WHERE m.user_id = ?1 ORDER BY i.period_start`),
    credits: await all("SELECT created_at, memo, amount_cents FROM credit_ledger WHERE user_id = ?1 ORDER BY created_at, rowid"),
    gift_cards_from_credits: await all("SELECT created_at, amount_cents, gift_card_last4, status FROM redemptions WHERE user_id = ?1 ORDER BY created_at"),
    welcome_piece: await all("SELECT status, chosen_at FROM gift_selections WHERE user_id = ?1"),
    anniversary_gifts: await all("SELECT n, status, created_at FROM anniversary_gifts WHERE user_id = ?1"),
    invitations_sent: await all("SELECT status, season, created_at FROM referrals WHERE referrer_user_id = ?1"),
    concierge: await all(`SELECT m.author, m.body, m.created_at FROM concierge_messages m JOIN concierge_threads t ON t.id = m.thread_id
      WHERE t.user_id = ?1 ORDER BY m.created_at`),
    room_photos: await all("SELECT room_label, note, created_at FROM room_photos WHERE user_id = ?1"),
    cancellations: await all(`SELECT c.reason, c.outcome, c.created_at FROM cancellations c JOIN memberships m ON m.id = c.membership_id WHERE m.user_id = ?1`),
  };
}

// deletionClosers entry: (env, userId, nowIso) → [statements]
export async function circleDeletion(env, userId, nowIso) {
  const photos = (await env.DB.prepare("SELECT r2_key FROM room_photos WHERE user_id = ?1").bind(userId).all()).results;
  if (env.ROOMS) {
    for (const p of photos) {
      try { await env.ROOMS.delete(p.r2_key); } catch (e) { console.error("room photo delete failed", e && e.name); }
    }
  }
  return [
    env.DB.prepare("DELETE FROM room_photos WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM concierge_messages WHERE thread_id IN (SELECT id FROM concierge_threads WHERE user_id = ?1)").bind(userId),
    env.DB.prepare("DELETE FROM concierge_threads WHERE user_id = ?1").bind(userId),
    env.DB.prepare("UPDATE member_object_claims SET status = 'cancelled', updated_at = ?1 WHERE user_id = ?2 AND status IN ('creating','invoiced')").bind(nowIso, userId),
    env.DB.prepare("UPDATE referral_codes SET disabled_at = ?1 WHERE user_id = ?2 AND disabled_at IS NULL").bind(nowIso, userId),
  ];
}
