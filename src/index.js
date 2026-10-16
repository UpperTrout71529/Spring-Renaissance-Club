// Worker entry point (wrangler.toml `main`). See src/app.js.
// scheduled: the daily cron trigger (wrangler.toml [triggers]) — data
// retention, spec §13.2 (src/cron/retention.js).
import { createApp } from "./app.js";
import { runRetention } from "./cron/retention.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRetention(env, event.scheduledTime || Date.now()).then(
      (removed) => console.log("retention", JSON.stringify(removed)),
      (e) => console.error("retention failed", e && e.name, e && e.message),
    ));
  },
};
