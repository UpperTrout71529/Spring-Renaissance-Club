import { serviceUnavailable } from "../http/errors.js";

// GET /health — liveness plus a D1 round trip, so "up" means "can serve".
export async function health({ env, json, nowIso }) {
  if (!env.DB) throw serviceUnavailable("db_unavailable");
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
  } catch (e) {
    console.error("health: D1 check failed", e && e.name);
    throw serviceUnavailable("db_unavailable");
  }
  return json({ status: "ok", time: nowIso() });
}
