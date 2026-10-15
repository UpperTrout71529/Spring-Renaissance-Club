// Transactional email through Resend (spec §9.3). Every send is keyed in
// `email_log.dedupe_key`: the INSERT is the "already sent?" check, and the
// same key goes to Resend as Idempotency-Key, so a retry never double-sends.

import { maskEmail } from "../lib/email-address.js";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = "Spring Renaissance <concierge@springrenaissance.store>";
const REPLY_TO = "concierge@springrenaissance.store";
const TIMEOUT_MS = 10000;

// message: { to, subject, html, text }. Returns "sent" | "duplicate" | "failed".
export async function sendEmail({ env, fetchImpl, id, userId, template, dedupeKey, message, nowIso }) {
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO email_log (id, user_id, template, dedupe_key, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'queued', ?5)`
  ).bind(id, userId || null, template, dedupeKey, nowIso).run();
  if (!claim.meta || claim.meta.changes !== 1) return "duplicate";

  const finish = (status, resendId = null) =>
    env.DB.prepare("UPDATE email_log SET status = ?1, resend_id = ?2 WHERE dedupe_key = ?3")
      .bind(status, resendId, dedupeKey).run();

  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY missing — email not sent", template);
    await finish("failed");
    return "failed";
  }

  try {
    const res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": dedupeKey,
      },
      body: JSON.stringify({
        from: FROM,
        reply_to: REPLY_TO,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("resend rejected", template, res.status, maskEmail(message.to));
      await finish("failed");
      return "failed";
    }
    const data = await res.json().catch(() => ({}));
    await finish("sent", data && typeof data.id === "string" ? data.id : null);
    return "sent";
  } catch (e) {
    console.error("resend unreachable", template, e && e.name, maskEmail(message.to));
    await finish("failed");
    return "failed";
  }
}
