// Minimal Stripe REST client for the Circle (V2). No SDK: the Worker sends
// form-encoded requests with the API version pinned on every call, so the
// account's default version (still used by the legacy handler) never matters.
//
// Test mode only until launch: a live key (sk_live_ / rk_live_) is refused
// unless CIRCLE_STRIPE_LIVE = "on", which is set only at the launch gate (T20).

export const STRIPE_API_VERSION = "2026-09-30.endive";
const API = "https://api.stripe.com";
const TIMEOUT_MS = 15000;

export class StripeError extends Error {
  constructor(status, code, message, type = null) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

const isLiveKey = (k) => /^(sk|rk)_live_/.test(k);
const isTestKey = (k) => /^(sk|rk)_test_/.test(k);

// True when the Circle can talk to Stripe in the mode this environment allows.
export function stripeConfigured(env) {
  const key = env && env.STRIPE_SECRET_KEY;
  if (typeof key !== "string" || !key) return false;
  if (isTestKey(key)) return true;
  return isLiveKey(key) && env.CIRCLE_STRIPE_LIVE === "on";
}

// Stripe's bracket notation: a[b][0][c]=x. null/undefined are skipped.
export function formEncode(params, prefix = "", out = []) {
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") formEncode(item, `${key}[${i}]`, out);
        else if (item !== undefined && item !== null) out.push([`${key}[${i}]`, String(item)]);
      });
    } else if (typeof v === "object") {
      formEncode(v, key, out);
    } else {
      out.push([key, String(v)]);
    }
  }
  return out;
}

const encode = (pairs) => new URLSearchParams(pairs).toString();

export async function stripeRequest(env, fetchImpl, method, path, params = {}, { idempotencyKey } = {}) {
  const key = env && env.STRIPE_SECRET_KEY;
  if (typeof key !== "string" || !key) throw new StripeError(503, "stripe_not_configured", "Stripe is not configured.");
  if (isLiveKey(key) && env.CIRCLE_STRIPE_LIVE !== "on") {
    throw new StripeError(503, "stripe_live_key_refused", "Live Stripe keys are not allowed before launch.");
  }
  if (!isLiveKey(key) && !isTestKey(key)) throw new StripeError(503, "stripe_not_configured", "Stripe key not recognised.");

  const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_API_VERSION };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let url = API + path;
  let body;
  const qs = encode(formEncode(params));
  if (method === "GET" || method === "DELETE") {
    if (qs) url += `?${qs}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = qs;
  }

  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new StripeError(503, "stripe_unreachable", "Stripe could not be reached.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data && data.error) || {};
    // Stripe's message never contains the key; it is passed on for the logs.
    throw new StripeError(res.status, err.code || "stripe_error", String(err.message || `Stripe ${res.status}`), err.type || null);
  }
  return data;
}
