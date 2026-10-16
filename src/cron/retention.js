// Data retention (spec §13.2), run daily by the cron trigger:
//   sessions            30 days after they ended (revoked, idle or absolute
//                       expiry — whichever came first), with their step-up code
//   step_up_codes       a day after expiry
//   magic_links         a day after use or expiry (sign-in and email change)
//   webauthn_challenges a day after expiry
//   events              13 months
// Users, consents, orders and the admin audit are not touched here: deleted
// accounts are anonymised at deletion time (§13.4), consents follow their own
// legal term.

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_GRACE_DAYS = 30;
const EVENTS_MONTHS = 13;

export async function runRetention(env, nowMs) {
  const iso = (ms) => new Date(ms).toISOString();
  const sessionCutoff = iso(nowMs - SESSION_GRACE_DAYS * DAY_MS);
  const dayAgo = iso(nowMs - DAY_MS);
  const eventsCutoff = new Date(nowMs);
  eventsCutoff.setUTCMonth(eventsCutoff.getUTCMonth() - EVENTS_MONTHS);

  const endedSessions = `SELECT id_hash FROM sessions
    WHERE COALESCE(revoked_at, MIN(idle_expires_at, absolute_expires_at)) < ?1`;
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM step_up_codes WHERE session_id_hash IN (${endedSessions}) OR expires_at < ?2`)
      .bind(sessionCutoff, dayAgo),
    env.DB.prepare(`DELETE FROM sessions WHERE id_hash IN (${endedSessions})`).bind(sessionCutoff),
    env.DB.prepare("DELETE FROM magic_links WHERE COALESCE(used_at, expires_at) < ?1 OR expires_at < ?1").bind(dayAgo),
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?1").bind(dayAgo),
    env.DB.prepare("DELETE FROM events WHERE created_at < ?1").bind(eventsCutoff.toISOString()),
  ]);
  const n = (r) => (r && r.meta && r.meta.changes) || 0;
  return {
    step_up_codes: n(results[0]), sessions: n(results[1]), magic_links: n(results[2]),
    webauthn_challenges: n(results[3]), events: n(results[4]),
  };
}
