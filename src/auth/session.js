// Sessions (spec §10.2). The cookie carries a random token; D1 stores only
// SHA-256(token + SESSION_PEPPER), so a leaked database cannot be replayed as
// cookies. Idle expiry slides (14 days by default) and is capped by an
// absolute limit of 90 days from sign-in. The sliding write happens at most
// once an hour per session, to keep D1 writes off the hot path.

import { serviceUnavailable } from "../http/errors.js";
import { randomToken, sha256Hex, TOKEN_RE } from "../lib/crypto.js";

export const SESSION_COOKIE = "__Host-sr_session";
const DAY_MS = 24 * 60 * 60 * 1000;
export const ABSOLUTE_DAYS = 90;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function idleDays(env) {
  const n = Number(env && env.SESSION_IDLE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function hashSessionToken(token, pepper) {
  return sha256Hex(token + pepper);
}

// __Host- prefix: Secure, Path=/, no Domain — the browser enforces all three,
// so the cookie can only ever belong to api.springrenaissance.store.
export function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function requirePepper(env) {
  if (!env.SESSION_PEPPER || !env.DB) throw serviceUnavailable("auth_unavailable");
}

// Creates a session row and returns the Set-Cookie value.
export async function createSession(env, { userId, authMethod, nowMs, uaSummary, geoCity, randomBytes }) {
  requirePepper(env);
  const token = randomToken(randomBytes);
  const idleMs = idleDays(env) * DAY_MS;
  const now = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at,
                           absolute_expires_at, auth_method, ua_summary, geo_city)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    await hashSessionToken(token, env.SESSION_PEPPER), userId, now,
    new Date(nowMs + idleMs).toISOString(),
    new Date(nowMs + ABSOLUTE_DAYS * DAY_MS).toISOString(),
    authMethod, uaSummary || null, geoCity || null
  ).run();
  return { token, cookie: sessionCookie(token, idleMs / 1000) };
}

// Returns { idHash, stepUpAt, authMethod, user, cookie? } for a live session,
// else null. `cookie` is set when the sliding window moved and the browser's
// copy needs a fresh Max-Age.
export async function loadSession(request, env, nowMs) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !TOKEN_RE.test(token)) return null;
  requirePepper(env);

  const nowIso = new Date(nowMs).toISOString();
  const idHash = await hashSessionToken(token, env.SESSION_PEPPER);
  // ISO strings written by Date#toISOString compare correctly as text.
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.step_up_at, s.auth_method, s.last_seen_at, s.absolute_expires_at,
            u.id, u.email, u.first_name, u.last_name, u.tier
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?1
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > ?2
        AND s.absolute_expires_at > ?2
        AND u.deleted_at IS NULL`
  ).bind(idHash, nowIso).first();
  if (!row) return null;

  const session = {
    idHash: row.id_hash,
    stepUpAt: row.step_up_at,
    authMethod: row.auth_method,
    user: { id: row.id, email: row.email, first_name: row.first_name, last_name: row.last_name, tier: row.tier },
    cookie: null,
  };

  if (nowMs - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
    const idleUntil = Math.min(nowMs + idleDays(env) * DAY_MS, Date.parse(row.absolute_expires_at));
    await env.DB.prepare(
      "UPDATE sessions SET last_seen_at = ?1, idle_expires_at = ?2 WHERE id_hash = ?3 AND revoked_at IS NULL"
    ).bind(nowIso, new Date(idleUntil).toISOString(), idHash).run();
    session.cookie = sessionCookie(token, (idleUntil - nowMs) / 1000);
  }
  return session;
}

export async function revokeSession(env, idHash, nowIso) {
  await env.DB.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id_hash = ?2 AND revoked_at IS NULL")
    .bind(nowIso, idHash).run();
}

// "Safari on iPhone" — enough to recognise a device in the sessions list
// (spec §6.8) without storing the raw User-Agent.
export function summarizeUserAgent(ua) {
  if (typeof ua !== "string" || !ua) return null;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) || /FxiOS/.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) || /CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os;
}
