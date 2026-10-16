import { defineConfig, devices } from "@playwright/test";

// Admin-only e2e (V2): its own port and no portal build, so it can run while
// the portal suite runs. The admin page is served from public/admin by the
// same e2e server (the portal pages are not needed here).
const PORT = 4444;
const BASE_URL = `https://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /admin.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, ignoreHTTPSErrors: true },
  projects: [
    { name: "chromium-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "webkit-375", use: { ...devices["Desktop Safari"], viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    command: "node e2e/server.mjs",
    env: { E2E_PORT: String(PORT) },
    url: `${BASE_URL}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
