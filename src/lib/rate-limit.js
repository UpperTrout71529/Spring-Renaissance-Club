// Sliding-window limiter over the baseline `rate_events` table — the same
// insert-then-count scheme as the legacy worker (ADR-005, E-2): the insert
// comes first so concurrent callers cannot all observe `limit - 1`, and a
// refused attempt withdraws its own row so a burst does not extend its own
// penalty. Unlike the legacy limiter this one fails closed: a sign-in
// endpoint that mails people must not become unlimited when D1 hiccups.

import { serviceUnavailable } from "../http/errors.js";

export async function withinLimit(env, { bucket, subject, limit, windowMs, nowMs }) {
  const floor = nowMs - windowMs;
  try {
    const [, insert] = await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_events WHERE bucket = ?1 AND subject = ?2 AND created_at < ?3")
        .bind(bucket, subject, floor),
      env.DB.prepare("INSERT INTO rate_events (bucket, subject, created_at) VALUES (?1, ?2, ?3)")
        .bind(bucket, subject, nowMs),
    ]);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ?1 AND subject = ?2 AND created_at >= ?3"
    ).bind(bucket, subject, floor).first();
    if (Number(row && row.n) <= limit) return true;

    const id = insert && insert.meta && insert.meta.last_row_id;
    if (id) {
      await env.DB.prepare("DELETE FROM rate_events WHERE id = ?1").bind(id).run();
    } else {
      await env.DB.prepare(
        "DELETE FROM rate_events WHERE id = (SELECT MAX(id) FROM rate_events WHERE bucket = ?1 AND subject = ?2)"
      ).bind(bucket, subject).run();
    }
    return false;
  } catch (e) {
    console.error("rate limiter unavailable", bucket, e && e.name);
    throw serviceUnavailable();
  }
}
