// S3 acceptance: Lighthouse Accessibility ≥ 95 on /login.
// Builds the e2e bundle, starts the e2e server, audits with Playwright's
// Chromium, exits non-zero below the threshold.
//
//   npm run lighthouse

import { spawn, execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

const THRESHOLD = 95;
const URLS = ["https://localhost:4443/login"];

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
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
