// Step-up (spec §10.4): a fresh confirmation — passkey, or a 6-digit code by
// email — within the last 15 minutes, for spending credits, changing email,
// removing a passkey, and exporting or deleting the account. Cancelling a
// membership deliberately does not need it (§14).

import { HttpError } from "../http/errors.js";

export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

export function hasFreshStepUp(session, nowMs) {
  if (!session || !session.stepUpAt) return false;
  const at = Date.parse(session.stepUpAt);
  return Number.isFinite(at) && nowMs - at <= STEP_UP_WINDOW_MS && at <= nowMs;
}

export function requireStepUp(ctx) {
  if (!hasFreshStepUp(ctx.session, ctx.now())) {
    throw new HttpError(403, "step_up_required", "Please confirm it's you to continue.");
  }
}

// A uniform 6-digit code: rejection sampling keeps every value equally likely.
export function sixDigitCode(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const limit = 4294000000; // largest multiple of 10^6 below 2^32
  for (;;) {
    const b = randomBytes(4);
    const n = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
    if (n < limit) return String(n % 1000000).padStart(6, "0");
  }
}

export async function markSteppedUp(env, idHash, nowIso) {
  await env.DB.prepare("UPDATE sessions SET step_up_at = ?1 WHERE id_hash = ?2 AND revoked_at IS NULL")
    .bind(nowIso, idHash).run();
}
