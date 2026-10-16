import { defineConfig, devices } from "@playwright/test";

const PORT = 4443;
const BASE_URL = `https://localhost:${PORT}`;

// Spec S3/S11: Chromium and WebKit, at 375×812 (mobile) and 1280×800 (desktop).
const viewports = {
  mobile: { width: 375, height: 812 },
  desktop: { width: 1280, height: 800 },
};

export default defineConfig({
  testDir: "e2e",
  // Admin specs run with playwright.admin.config.ts (own port, no portal build).
  testIgnore: /admin-.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, ignoreHTTPSErrors: true },
  projects: [
    { name: "chromium-375", use: { ...devices["Desktop Chrome"], viewport: viewports.mobile } },
    { name: "chromium-1280", use: { ...devices["Desktop Chrome"], viewport: viewports.desktop } },
    { name: "webkit-375", use: { ...devices["Desktop Safari"], viewport: viewports.mobile } },
    { name: "webkit-1280", use: { ...devices["Desktop Safari"], viewport: viewports.desktop } },
  ],
  webServer: {
    command: "npm run build:e2e && node e2e/server.mjs",
    url: `${BASE_URL}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
