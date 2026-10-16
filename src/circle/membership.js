// Membership lookups shared by the Circle routes, the webhooks and the cron.

export const LIVE_STATUSES = ["pending", "active", "past_due", "canceling"];
const LIVE_SQL = LIVE_STATUSES.map((s) => `'${s}'`).join(",");

// The membership that is not over yet, if any (newest first).
export async function liveMembership(env, userId) {
  return env.DB.prepare(
    `SELECT * FROM memberships WHERE user_id = ?1 AND status IN (${LIVE_SQL}) ORDER BY created_at DESC, id DESC LIMIT 1`
  ).bind(userId).first();
}

// The most recent membership of any status.
export async function latestMembership(env, userId) {
  return env.DB.prepare("SELECT * FROM memberships WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1")
    .bind(userId).first();
}

export async function hasPastMembership(env, userId) {
  const row = await env.DB.prepare("SELECT 1 AS yes FROM memberships WHERE user_id = ?1 LIMIT 1").bind(userId).first();
  return !!row;
}
