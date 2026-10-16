// Cloudflare Turnstile server-side check (spec §6.2, §10.6). Fails closed:
// without TURNSTILE_SECRET no token is accepted. For local development use
// Cloudflare's published test secret that always passes.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 10000;

export async function verifyTurnstile(env, fetchImpl, token) {
  if (!env.TURNSTILE_SECRET) {
    console.error("TURNSTILE_SECRET missing — refusing sign-in link requests");
    return false;
  }
  if (typeof token !== "string" || !token || token.length > 2048) return false;

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.success === true;
  } catch (e) {
    console.error("turnstile siteverify failed", e && e.name);
    return false;
  }
}
