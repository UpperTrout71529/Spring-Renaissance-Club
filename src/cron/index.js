// Cron dispatcher (docs/tz-v2-circle.md §15). Workers Free allows five cron
// triggers per account, so the Worker has two: every five minutes (member
// price reconcile, claim expiry, reminders) and daily at 03:15 UTC
// (retention, credit expiry, Stripe reconcile). Each job runs on its own: a
// failure is logged and the next job still runs.

import { runRetention } from "./retention.js";

export const FREQUENT_CRON = "*/5 * * * *";
export const DAILY_CRON = "15 3 * * *";

// Jobs: { name, run(env, nowMs, deps) → summary }. Later tasks add theirs.
export const JOBS = {
  frequent: [],
  daily: [
    { name: "retention", run: (env, nowMs) => runRetention(env, nowMs) },
  ],
};

export async function runScheduled(env, nowMs, cron, { jobs = JOBS, deps = {} } = {}) {
  const list = cron === FREQUENT_CRON ? jobs.frequent : cron === DAILY_CRON ? jobs.daily : [];
  const out = {};
  for (const job of list) {
    try {
      out[job.name] = await job.run(env, nowMs, deps);
    } catch (e) {
      console.error("cron job failed", job.name, e && e.name, e && e.message);
      out[job.name] = "failed";
    }
  }
  return out;
}
