// S3 acceptance: Lighthouse Accessibility ≥ 95 on /login.
// S11 acceptance: LCP < 2.5 s on Home under Lighthouse's "Slow 4G" mobile
// throttling (simulated: 150 ms RTT, 1.6 Mbps, 4× CPU slowdown), signed in.
// Builds the e2e bundle, starts the e2e server, audits with Playwright's
// Chromium, exits non-zero below a threshold.
//
//   npm run lighthouse

import { spawn, execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

const THRESHOLD = 95;
const ORIGIN = "https://localhost:4443";
const URLS = [`${ORIGIN}/login`];
const LCP_BUDGET_MS = 2500;
// Lighthouse's default mobile throttling, written out so a Lighthouse upgrade
// cannot quietly change what "Slow 4G" means here.
const SLOW_4G = { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 };

// A real session on the e2e Worker (self-signed certificate: local only).
async function signedInCookie() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const email = `lighthouse-${Date.now()}@example.com`;
  const headers = { "Content-Type": "application/json", Origin: ORIGIN, "X-SR-Client": "portal" };
  await fetch(`${ORIGIN}/api/auth/magic-link`, { method: "POST", headers, body: JSON.stringify({ email, turnstile_token: "e2e-token" }) });
  const { link } = await (await fetch(`${ORIGIN}/__e2e/last-link?email=${encodeURIComponent(email)}`)).json();
  const token = new URL(link).hash.replace("#t=", "");
  const res = await fetch(`${ORIGIN}/api/auth/verify`, { method: "POST", headers, body: JSON.stringify({ token }) });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-sr_session="));
  if (!cookie) throw new Error(`sign-in for Lighthouse failed: ${res.status}`);
  return cookie.split(";")[0];
}

execSync("npm run build:e2e", { stdio: "ignore" });
const server = spawn(process.execPath, ["e2e/server.mjs"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("e2e server") && resolve()));

// Playwright's Chromium with a DevTools port for Lighthouse to drive.
const DEBUG_PORT = 9223;
const browser = await chromium.launch({
  args: [`--remote-debugging-port=${DEBUG_PORT}`, "--ignore-certificate-errors"],
});

let failed = false;
try {
  for (const url of URLS) {
    for (const formFactor of ["mobile", "desktop"]) {
      const result = await lighthouse(url, {
        port: DEBUG_PORT,
        onlyCategories: ["accessibility"],
        formFactor,
        screenEmulation: formFactor === "desktop"
          ? { mobile: false, width: 1280, height: 800, deviceScaleFactor: 1, disabled: false }
          : { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false },
        logLevel: "error",
      });
      if (result.lhr.runtimeError) console.log("runtimeError:", result.lhr.runtimeError.code, result.lhr.runtimeError.message);
      const score = Math.round(result.lhr.categories.accessibility.score * 100);
      const misses = Object.values(result.lhr.audits)
        .filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode === "binary")
        .map((a) => a.id);
      console.log(`${url} [${formFactor}] accessibility ${score}${misses.length ? ` — failing: ${misses.join(", ")}` : ""}`);
      if (score < THRESHOLD) failed = true;
    }
  }

  const cookie = await signedInCookie();
  const home = await lighthouse(`${ORIGIN}/`, {
    port: DEBUG_PORT,
    onlyCategories: ["performance"],
    formFactor: "mobile",
    screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false },
    throttlingMethod: "simulate",
    throttling: SLOW_4G,
    extraHeaders: { Cookie: cookie },
    logLevel: "error",
  });
  const lcp = home.lhr.audits["largest-contentful-paint"].numericValue;
  const fcp = home.lhr.audits["first-contentful-paint"].numericValue;
  const cls = home.lhr.audits["cumulative-layout-shift"].numericValue;
  const signedIn = !home.lhr.finalDisplayedUrl.includes("/login");
  console.log(`${ORIGIN}/ [mobile, Slow 4G] LCP ${Math.round(lcp)} ms, FCP ${Math.round(fcp)} ms, CLS ${cls.toFixed(3)}, performance ${Math.round(home.lhr.categories.performance.score * 100)}${signedIn ? "" : " — NOT signed in"}`);
  if (process.env.LH_DEBUG) {
    const a = home.lhr.audits;
    const pick = (id) => a[id] && JSON.stringify(a[id].details, null, 0).slice(0, 1500);
    for (const id of ["largest-contentful-paint-element", "lcp-breakdown-insight", "render-blocking-insight", "network-dependency-tree-insight", "font-display-insight", "cls-culprits-insight", "layout-shifts"]) console.log(id, pick(id));
    console.log("requests", JSON.stringify(a["network-requests"].details.items.map((r) => [r.url.replace(ORIGIN, ""), r.transferSize, r.resourceSize, r.mimeType])));
  }
  if (!signedIn || lcp >= LCP_BUDGET_MS) failed = true;
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
