// Circle emails through the shared sender (email_log dedupe + Resend
// Idempotency-Key). `svc` is anything with env, fetch, newId and nowIso — the
// request ctx or the cron's service object.

import { sendEmail } from "../email/send.js";
import { renderEmail } from "../email/templates/layout.js";
import { CIRCLE_TEMPLATES } from "../email/templates/circle.js";
import { portalUrl } from "../routes/auth.js";

export async function sendCircleEmail(svc, { userId, to, template, dedupeKey, vars = {} }) {
  const build = CIRCLE_TEMPLATES[template];
  if (!build || !to) return "skipped";
  const portal = portalUrl(svc.env);
  const t = build({ portal, ...vars });
  const message = renderEmail({ to, subject: t.subject, heading: t.heading, paragraphs: t.paragraphs, button: t.button, portalUrl: portal });
  return sendEmail({ env: svc.env, fetchImpl: svc.fetch, id: svc.newId(), userId, template, dedupeKey, message, nowIso: svc.nowIso() });
}

export async function emailUser(svc, userId, template, dedupeKey, vars) {
  const u = await svc.env.DB.prepare("SELECT email FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(userId).first();
  if (!u) return "skipped";
  return sendCircleEmail(svc, { userId, to: u.email, template, dedupeKey, vars });
}

// A signal for Felix (spec §11: disputes, failed webhooks, flags) — to
// ADMIN_NOTIFY_EMAIL only; nothing when it is not configured.
export async function notifyFelix(svc, { dedupeKey, title, lines }) {
  const to = svc.env.ADMIN_NOTIFY_EMAIL;
  if (!to) return "skipped";
  return sendCircleEmail(svc, { userId: null, to, template: "admin_signal", dedupeKey, vars: { title, lines } });
}

// admin_flags + a signal to Felix, once per dedupe key.
export async function raiseFlag(svc, { kind, dedupeKey, userId = null, ref = null, details = null, title, lines }) {
  const res = await svc.env.DB.prepare(
    `INSERT OR IGNORE INTO admin_flags (id, kind, dedupe_key, user_id, ref, details_json, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)`
  ).bind(svc.newId(), kind, dedupeKey, userId, ref, JSON.stringify({ ...(details || {}), title, lines }), svc.nowIso()).run();
  if (res.meta && res.meta.changes === 1) {
    await notifyFelix(svc, { dedupeKey: `flag:${dedupeKey}`, title, lines }).catch((e) => console.error("flag email failed", e && e.name));
  }
}
