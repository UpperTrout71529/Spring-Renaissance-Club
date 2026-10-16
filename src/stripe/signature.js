// Stripe webhook signatures (Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]).
// HMAC-SHA256 over "<t>.<raw body>" with the endpoint's signing secret; any
// one v1 may match (secret rotation); the timestamp must be within 300 s of
// now, so a captured delivery cannot be replayed later. Verification goes
// through crypto.subtle.verify, which compares in constant time.

const TOLERANCE_S = 300;

function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyStripeSignature(rawBody, header, secret, nowS, toleranceS = TOLERANCE_S) {
  if (typeof header !== "string" || !header || typeof secret !== "string" || !secret) return false;
  if (typeof rawBody !== "string") return false;
  const pairs = header.split(",").map((part) => {
    const i = part.indexOf("=");
    return i === -1 ? null : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(Boolean);
  const t = (pairs.find(([k]) => k === "t") || [])[1];
  const sigs = pairs.filter(([k]) => k === "v1").map(([, v]) => hexToBytes(v)).filter(Boolean);
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowS - Number(t)) > toleranceS) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const data = new TextEncoder().encode(`${t}.${rawBody}`);
  for (const sig of sigs) {
    if (await crypto.subtle.verify("HMAC", key, sig, data)) return true;
  }
  return false;
}
