// Step-up confirmation (spec §8.2, §10.4): a 6-digit code by email (10
// minutes, 5 attempts) or a passkey assertion. Success stamps
// sessions.step_up_at; requireStepUp() then admits sensitive actions for 15
// minutes.

import { HttpError, badRequest, tooManyRequests } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { sha256Hex } from "../lib/crypto.js";
import { withinLimit } from "../lib/rate-limit.js";
import { markSteppedUp, sixDigitCode } from "../auth/step-up.js";
import { sendEmail } from "../email/send.js";
import { stepUpCodeEmail } from "../email/templates/step-up-code.js";
import { portalUrl } from "./auth.js";
import { verifyStepUpPasskey } from "./passkeys.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = { bucket: "step_up_code_user", limit: 5, windowMs: 60 * 60 * 1000 };

const codeHash = (code, idHash, pepper) => sha256Hex(`${code}:${idHash}:${pepper}`);

// POST /api/auth/step-up/email-code (session) → 202; a new code replaces the
// session's previous one.
export async function sendStepUpCode(ctx) {
  const { env, session } = ctx;
  if (!(await withinLimit(env, { ...CODES_PER_HOUR, subject: session.user.id, nowMs: ctx.now() }))) {
    throw tooManyRequests();
  }
  const code = sixDigitCode(ctx.randomBytes);
  const nowIso = ctx.nowIso();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO step_up_codes (session_id_hash, code_hash, attempts, expires_at, created_at)
     VALUES (?1, ?2, 0, ?3, ?4)`
  ).bind(session.idHash, await codeHash(code, session.idHash, env.SESSION_PEPPER),
    new Date(ctx.now() + CODE_TTL_MS).toISOString(), nowIso).run();

  const id = ctx.newId();
  ctx.waitUntil(sendEmail({
    env,
    fetchImpl: ctx.fetch,
    id,
    userId: session.user.id,
    template: "step_up_code",
    dedupeKey: `step_up_code:${id}`,
    message: stepUpCodeEmail({ to: session.user.email, code, portalUrl: portalUrl(env) }),
    nowIso,
  }));
  return ctx.json({ ok: true }, 202);
}

// POST /api/auth/step-up/verify { code } | { passkey_response } (session) → 204.
export async function verifyStepUp(ctx) {
  const { env, session } = ctx;
  const body = await readJson(ctx.request);
  const nowIso = ctx.nowIso();

  if (body.passkey_response !== undefined) {
    await verifyStepUpPasskey(ctx, body.passkey_response);
  } else {
    const code = typeof body.code === "string" ? body.code.trim() : "";
    // Each attempt is charged before the comparison, by a guarded UPDATE, so
    // parallel guesses cannot exceed the five allowed.
    const charged = await env.DB.prepare(
      `UPDATE step_up_codes SET attempts = attempts + 1
        WHERE session_id_hash = ?1 AND attempts < ?2 AND expires_at > ?3`
    ).bind(session.idHash, MAX_ATTEMPTS, nowIso).run();
    if (!charged.meta || charged.meta.changes !== 1) {
      const row = await env.DB.prepare("SELECT attempts, expires_at FROM step_up_codes WHERE session_id_hash = ?1")
        .bind(session.idHash).first();
      if (row && row.attempts >= MAX_ATTEMPTS && row.expires_at > nowIso) {
        throw new HttpError(429, "too_many_attempts", "Too many attempts. We can send you a new code.");
      }
      throw badRequest("code_expired", "This code has expired. We can send you a new one.");
    }
    const row = await env.DB.prepare("SELECT code_hash FROM step_up_codes WHERE session_id_hash = ?1")
      .bind(session.idHash).first();
    const ok = /^\d{6}$/.test(code) && row && row.code_hash === (await codeHash(code, session.idHash, env.SESSION_PEPPER));
    if (!ok) throw badRequest("code_incorrect", "That code isn't right. Please check it and try again.");
    await env.DB.prepare("DELETE FROM step_up_codes WHERE session_id_hash = ?1").bind(session.idHash).run();
  }

  await markSteppedUp(env, session.idHash, nowIso);
  return new Response(null, { status: 204 });
}
