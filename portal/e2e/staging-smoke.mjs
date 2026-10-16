// S11: smoke test of the deployed staging pair, in Chromium and WebKit —
// club-staging. (Pages) calling api-staging. (Worker) across subdomains.
//
//   node e2e/staging-smoke.mjs [https://club-staging.springrenaissance.store]
//
// Checks: /login renders with the CSP meta and no console errors; the
// sign-in form posts to the API cross-origin with credentials and gets the
// "Check your inbox" answer (Turnstile runs with Cloudflare's always-pass
// test keys on staging); a signed-out deep link lands on /login; /health and
// the admin gate answer as they should. The full sign-in (link from the
// email → cookie survives a reload in WebKit) needs a real inbox and is run
// by hand: see docs/launch-v1.md.

import { chromium, webkit } from "@playwright/test";

const PORTAL = process.argv[2] || "https://club-staging.springrenaissance.store";
const API = PORTAL.replace("://club-staging.", "://api-staging.");
let failed = false;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed = true; };

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  // A signed-out /api/me answers 401 by design; browsers log that as an error.
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("status of 401")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(`${PORTAL}/orders`);
    await page.waitForURL(/\/login/, { timeout: 15000 });
    check(page.url().includes("return_to=%2Forders"), `${name}: signed-out deep link → /login?return_to=/orders`);
    check(!!(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")), `${name}: CSP meta present`);

    const email = `staging-smoke-${name}-${Date.now()}@example.com`;
    await page.getByLabel("Email address").fill(email);
    const answer = page.waitForResponse((r) => r.url() === `${API}/api/auth/magic-link`, { timeout: 45000 }); // Turnstile is slower in WebKit
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    const res = await answer;
    check(res.status() === 202, `${name}: POST ${API}/api/auth/magic-link → ${res.status()} (cross-origin, credentials)`);
    check(res.headers()["access-control-allow-origin"] === PORTAL, `${name}: CORS allows exactly ${PORTAL}`);
    await page.getByRole("heading", { name: "Check your inbox" }).waitFor({ timeout: 10000 });
    check(true, `${name}: "Check your inbox" shown`);
    check(errors.length === 0, `${name}: no console errors${errors.length ? ` — ${errors.join(" | ")}` : ""}`);
  } catch (e) {
    check(false, `${name}: ${e.message.split("\n")[0]}`);
  } finally {
    await browser.close();
  }
}

const health = await fetch(`${API}/health`);
check(health.status === 200, `GET ${API}/health → ${health.status}`);
const me = await fetch(`${API}/api/me`);
check(me.status === 401, `GET ${API}/api/me without a session → ${me.status}`);
const admin = await fetch(`${API}/api/admin/members`);
check(admin.status === 403, `GET ${API}/api/admin/members without Access → ${admin.status}`);
const foreign = await fetch(`${API}/api/auth/magic-link`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-SR-Client": "portal" }, body: "{}" });
check(foreign.status === 403, `POST from a foreign Origin → ${foreign.status}`);

process.exit(failed ? 1 : 0);
