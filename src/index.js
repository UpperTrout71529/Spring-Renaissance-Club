// Worker entry point (wrangler.toml `main`). See src/app.js.
// scheduled: the cron triggers (wrangler.toml [triggers]) — every five
// minutes and daily at 03:15 UTC, dispatched in src/cron/index.js.
import { createApp } from "./app.js";
import { runScheduled } from "./cron/index.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event.scheduledTime || Date.now(), event.cron).then(
      (summary) => console.log("cron", event.cron, JSON.stringify(summary)),
      (e) => console.error("cron failed", event.cron, e && e.name, e && e.message),
    ));
  },
};
