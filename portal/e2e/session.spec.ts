// S2 acceptance moved to S3: with the real Worker code (no API mocks), sign in
// by email link and check the __Host- session cookie survives a reload — in
// WebKit as well as Chromium.

import { expect, test } from "@playwright/test";
import { stubTurnstile } from "./helpers";

test("sign in by link → cookie set → still signed in after reload", async ({ page, context, request }, info) => {
  await stubTurnstile(page);
  const email = `e2e-${info.project.name}-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

  const { link } = await (await request.get(`/__e2e/last-link?email=${encodeURIComponent(email)}`)).json();
  expect(link).toMatch(/\/auth#t=[A-Za-z0-9_-]{43}$/);

  const verified = page.waitForResponse((r) => r.url().endsWith("/api/auth/verify"));
  await page.goto(link);
  const setCookie = (await (await verified).headerValue("set-cookie")) ?? "";
  expect(setCookie).toMatch(/^__Host-sr_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1209600$/);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  const cookie = (await context.cookies()).find((c) => c.name === "__Host-sr_session");
  expect(cookie).toBeTruthy();
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: "/" });
  // Playwright's WebKit reports every cookie as SameSite=None (seen on
  // Windows); the Set-Cookie header asserted above is the source of truth.
  if (!info.project.name.startsWith("webkit")) {
    expect(cookie!.sameSite).toBe("Lax");
  }
  expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(13 * 24 * 3600);

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);

  // The same link cannot be used twice.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
});
