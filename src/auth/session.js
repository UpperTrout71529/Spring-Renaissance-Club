// Session lookup (spec §10.2). The cookie carries a random token; D1 stores
// only SHA-256(token + SESSION_PEPPER), so a leaked database cannot be replayed
// as cookies. Issuing, sliding renewal and revocation arrive with S2.

import { serviceUnavailable } from "../http/errors.js";

export const SESSION_COOKIE = "__Host-sr_session";

// 32 random bytes, base64url, no padding.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function hashSessionToken(token, pepper) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token + pepper));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns { idHash, stepUpAt, authMethod, user } for a live session, else null.
export async function loadSession(request, env, nowIso) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !TOKEN_RE.test(token)) return null;
  if (!env.SESSION_PEPPER || !env.DB) throw serviceUnavailable("auth_unavailable");

  const idHash = await hashSessionToken(token, env.SESSION_PEPPER);
  // ISO strings written by Date#toISOString compare correctly as text.
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.step_up_at, s.auth_method,
            u.id, u.email, u.first_name, u.last_name, u.tier
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?1
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > ?2
        AND s.absolute_expires_at > ?2
        AND u.deleted_at IS NULL`
  ).bind(idHash, nowIso).first();
  if (!row) return null;

  return {
    idHash: row.id_hash,
    stepUpAt: row.step_up_at,
    authMethod: row.auth_method,
    user: {
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      tier: row.tier,
    },
  };
}
