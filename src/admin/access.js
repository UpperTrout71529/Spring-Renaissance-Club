// Admin gate (spec §12, P0.8). Cloudflare Access stands in front of
// /admin* and /api/admin/* and adds a signed JWT to each request it lets
// through; the Worker verifies that JWT itself, so a request that reaches the
// Worker some other way (workers.dev, a misconfigured route) still gets 403.
//
// Config (plain vars, not secret):
//   ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com — the JWT issuer;
//                       its keys are at /cdn-cgi/access/certs
//   ACCESS_AUD          the Access application's AUD tag
//   ADMIN_EMAILS        comma-separated; compared case-insensitively
// Any of them missing → every admin request is refused.
//
// Verification follows Cloudflare's guide (Access → validate JWTs): RS256
// signature by a key from the team's JWKS, `iss` = team domain, `aud`
// contains our AUD, `exp`/`nbf` checked against the injected clock.

import { forbidden } from "../http/errors.js";

const KEYS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const TIMEOUT_MS = 5000;

let keyCache = null; // { team, fetchedAt, keys: Map<kid, CryptoKey> }

export function _resetAccessKeys() {
  keyCache = null;
}

const refuse = () => forbidden("admin_forbidden", "You do not have access to this page.");

function decodePart(part) {
  const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const decodeJson = (part) => JSON.parse(new TextDecoder().decode(decodePart(part)));

async function fetchKeys(team, fetchImpl, nowMs) {
  const res = await fetchImpl(`${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`access certs http ${res.status}`);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    const { kty, n, e } = jwk;
    map.set(jwk.kid, await crypto.subtle.importKey(
      "jwk", { kty, n, e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    ));
  }
  keyCache = { team, fetchedAt: nowMs, keys: map };
  return map;
}

// The key for `kid`: from the cache while it is under an hour old; an
// unknown kid triggers one refetch (Access rotates its keys).
async function keyFor(kid, team, fetchImpl, nowMs) {
  const usable = keyCache && keyCache.team === team && nowMs - keyCache.fetchedAt < KEYS_TTL_MS;
  if (usable && keyCache.keys.has(kid)) return keyCache.keys.get(kid);
  const keys = await fetchKeys(team, fetchImpl, nowMs);
  return keys.get(kid) || null;
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// → { email } of a verified admin, or throws 403.
export async function verifyAdmin(request, env, fetchImpl, nowMs) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "").replace(/\/+$/, "");
  const allowed = adminEmails(env);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!team || !env.ACCESS_AUD || !allowed.length || !token) throw refuse();

  let claims;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("shape");
    const [h, p, s] = parts;
    const header = decodeJson(h);
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("alg");
    const key = await keyFor(header.kid, team, fetchImpl, nowMs);
    if (!key) throw new Error("kid");
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, decodePart(s), new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) throw new Error("signature");
    claims = decodeJson(p);
  } catch (e) {
    console.error("admin jwt rejected", e && e.message);
    throw refuse();
  }

  const nowS = Math.floor(nowMs / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (
    claims.iss !== team ||
    !aud.includes(env.ACCESS_AUD) ||
    typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= nowS ||
    (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowS) ||
    !email || !allowed.includes(email)
  ) {
    throw refuse();
  }
  return { email };
}
