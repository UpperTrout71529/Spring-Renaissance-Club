// Spec §10.6 and §13.1: CORS for exactly two origins, with credentials, never
// `*`. Every state-changing request must also come from an allowed Origin and
// carry `X-SR-Client: portal` — together with SameSite=Lax cookies that is the
// CSRF defence: a cross-site form cannot set a custom header, and a
// cross-site fetch that sets one needs a preflight this worker refuses.

import { forbidden } from "./errors.js";

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://club.springrenaissance.store",
  "https://springrenaissance.store",
];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, X-SR-Client, Idempotency-Key";

// ALLOWED_ORIGINS (comma-separated) replaces the default list, e.g. to add
// http://localhost:5173 for local portal development.
export function allowedOrigins(env) {
  const raw = env && typeof env.ALLOWED_ORIGINS === "string" ? env.ALLOWED_ORIGINS : "";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_ORIGINS;
}

export function isAllowedOrigin(origin, env) {
  return !!origin && allowedOrigins(env).includes(origin);
}

export function corsHeaders(origin, env) {
  if (!isAllowedOrigin(origin, env)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function preflightHeaders(origin, env, allowed) {
  return {
    ...corsHeaders(origin, env),
    "Access-Control-Allow-Methods": allowed ? [...allowed, "OPTIONS"].join(", ") : ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "600",
  };
}

export function isSafeMethod(method) {
  return SAFE_METHODS.has(method);
}

// Throws 403 unless a state-changing request is same-site and from the portal.
export function assertTrustedMutation(request, env) {
  if (isSafeMethod(request.method)) return;
  if (!isAllowedOrigin(request.headers.get("Origin"), env)) {
    throw forbidden("origin_not_allowed", "This request is not allowed from here.");
  }
  if (request.headers.get("X-SR-Client") !== "portal") {
    throw forbidden("client_header_missing", "This request is not allowed from here.");
  }
}
