// /login and /auth against a mocked API (§6.2, §10.1), plus axe on /login.

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mockSignedOut, stubTurnstile, USER } from "./helpers";

const TOKEN = "T".repeat(43);

test.beforeEach(async ({ page }) => {
  await stubTurnstile(page);
});

test("axe: /login has no WCAG 2.2 A/AA violations", async ({ page }) => {
  await mockSignedOut(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("axe: the sent state has no violations either", async ({ page }) => {
  await mockSignedOut(page);
  await page.route("**/api/auth/magic-link", (r) => r.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' }));
  await page.goto("/login");
  await page.getByLabel("Email address").fill("clara@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test("login: sends email, Turnstile token and return_to; shows Check your inbox", async ({ page }) => {
  await mockSignedOut(page);
  let sent: Record<string, unknown> | null = null;
  let headers: Record<string, string> = {};
  await page.route("**/api/auth/magic-link", async (route) => {
    sent = route.request().postDataJSON();
    headers = route.request().headers();
    await route.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("/login?return_to=%2Fsaved");
  await page.getByLabel("Email address").fill("clara@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();

  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  await expect(page.getByText("We sent a sign-in link to clara@example.com. It works for 15 minutes.")).toBeVisible();
  expect(sent).toEqual({ email: "clara@example.com", turnstile_token: "e2e-token", return_to: "/saved" });
  expect(headers["x-sr-client"]).toBe("portal");
  // Resend becomes available after 30 seconds.
  await expect(page.getByRole("button", { name: /Resend link in \d+ s/ })).toBeDisabled();
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
});

test("login: an invalid address is caught before any request", async ({ page }) => {
  await mockSignedOut(page);
  let calls = 0;
  await page.route("**/api/auth/magic-link", (r) => { calls++; return r.fulfill({ status: 202, body: "{}" }); });
  await page.goto("/login");
  await page.getByLabel("Email address").fill("not-an-email");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  const input = page.getByLabel("Email address");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveText("Please enter a valid email address.");
  await expect(input).toBeFocused();
  expect(calls).toBe(0);
});

test("login: a rate limit shows the spec's message", async ({ page }) => {
  await mockSignedOut(page);
  await page.route("**/api/auth/magic-link", (r) => r.fulfill({
    status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited", message: "x" } }),
  }));
  await page.goto("/login");
  await page.getByLabel("Email address").fill("clara@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("alert")).toHaveText("Too many requests. Please wait a few minutes and try again.");
});

test("auth: a valid link signs in, strips the token and goes to return_to", async ({ page }) => {
  let body: unknown = null;
  await page.route("**/api/auth/verify", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: USER, return_to: "/saved" }) });
  });
  await page.goto(`/auth#t=${TOKEN}`);
  await expect(page).toHaveURL(/\/saved$/);
  expect(body).toEqual({ token: TOKEN });
  await expect(page.getByRole("heading", { level: 1, name: "Saved" })).toBeVisible();
  // The token never stays in history.
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("auth: a spent or expired link shows This link has expired", async ({ page }) => {
  await page.route("**/api/auth/verify", (r) => r.fulfill({
    status: 410, contentType: "application/json", body: JSON.stringify({ error: { code: "link_expired", message: "x" } }),
  }));
  await page.goto(`/auth#t=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await expect(page.getByText("Sign-in links work once and for 15 minutes. We can send a fresh one.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Send a new link" })).toHaveAttribute("href", "/login");
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("auth: no token at all → expired, without calling the API", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/auth/verify", (r) => { calls++; return r.fulfill({ status: 200, body: "{}" }); });
  await page.goto("/auth");
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  expect(calls).toBe(0);
});

test("sign out calls logout and returns to /login", async ({ page }) => {
  await page.route("**/api/me", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ user: USER, membership: null, badges: { circle: false }, onboarding: { passkey: false, saved: false } }),
  }));
  let loggedOut = false;
  await page.route("**/api/auth/logout", (r) => { loggedOut = true; return r.fulfill({ status: 204 }); });
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 0) < 1024) test.skip(true, "Sign out lives in Account on mobile (S9)");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(loggedOut).toBe(true);
});
