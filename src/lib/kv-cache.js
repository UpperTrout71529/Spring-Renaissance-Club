// Read-through cache in KV for Shopify reads (spec §9.2.3: 5 minutes per
// user). KV failures are logged and bypassed — the cache never breaks a read.
// Keys must include the user id, so one user's data is never served to another.

export const SHOPIFY_CACHE_TTL_SECONDS = 5 * 60;

export async function cached(env, key, load, ttlSeconds = SHOPIFY_CACHE_TTL_SECONDS) {
  try {
    const hit = await env.CLIENT_KV.get(key, { type: "json" });
    if (hit) return hit;
  } catch (e) {
    console.error("cache read failed", e && e.name);
  }
  const value = await load();
  try {
    await env.CLIENT_KV.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  } catch (e) {
    console.error("cache write failed", e && e.name);
  }
  return value;
}
