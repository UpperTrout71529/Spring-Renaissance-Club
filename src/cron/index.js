// Cron dispatcher (docs/tz-v2-circle.md §15). Workers Free allows five cron
// triggers per account, so the Worker has two: every five minutes (member
// price reconcile, claim expiry, reminders, Stripe reconcile) and daily at
// 03:15 UTC (retention, credit expiry, expiring-credit and welcome emails).
// Each job runs on its own: a failure is logged and the next job still runs.
// Jobs get a service object shaped like a request ctx (env, fetch, now,
// nowIso, newId, waitUntil), so the Circle code runs the same in both.

import { runRetention } from "./retention.js";
import { creditsExpiring, creditsExpiry, renewalReminders, stripeReconcile, welcomeReminders } from "./circle-jobs.js";
import { ulid } from "../lib/ulid.js";
import { syncMemberPrice } from "../circle/member-price.js";
import { expireClaims, guardReleases } from "../circle/member-object.js";
import { registerCircle } from "../circle/register.js";

registerCircle();

export const FREQUENT_CRON = "*/5 * * * *";
export const DAILY_CRON = "15 3 * * *";

// Jobs: { name, run(env, nowMs, deps) → summary }; deps.svc is the service object.
export const JOBS = {
  frequent: [
    { name: "member_price", run: (env, nowMs, deps) => syncMemberPrice(deps.svc) },
    { name: "object_claims", run: (env, nowMs, deps) => expireClaims(deps.svc) },
    { name: "renewal_reminders", run: (env, nowMs, deps) => renewalReminders(deps.svc) },
    { name: "stripe_reconcile", run: (env, nowMs, deps) => stripeReconcile(deps.svc) },
  ],
  daily: [
    { name: "retention", run: (env, nowMs) => runRetention(env, nowMs) },
    { name: "credits_expiry", run: (env, nowMs, deps) => creditsExpiry(deps.svc) },
    { name: "credits_expiring", run: (env, nowMs, deps) => creditsExpiring(deps.svc) },
    { name: "object_guard", run: (env, nowMs, deps) => guardReleases(deps.svc) },
    { name: "welcome_reminders", run: (env, nowMs, deps) => welcomeReminders(deps.svc) },
  ],
};

export function makeSvc(env, nowMs, fetchImpl = (...a) => globalThis.fetch(...a)) {
  const pending = [];
  return {
    env,
    fetch: fetchImpl,
    now: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    newId: () => ulid(nowMs),
    waitUntil: (p) => pending.push(Promise.resolve(p).catch((e) => console.error("cron after-effect failed", e && e.message))),
    settle: () => Promise.all(pending.splice(0)),
  };
}

export async function runScheduled(env, nowMs, cron, { jobs = JOBS, deps = {} } = {}) {
  const list = cron === FREQUENT_CRON ? jobs.frequent : cron === DAILY_CRON ? jobs.daily : [];
  const svc = deps.svc || makeSvc(env, nowMs, deps.fetch);
  const out = {};
  for (const job of list) {
    try {
      out[job.name] = await job.run(env, nowMs, { ...deps, svc });
      await svc.settle();
    } catch (e) {
      console.error("cron job failed", job.name, e && e.name, e && e.message);
      out[job.name] = "failed";
    }
  }
  return out;
}
