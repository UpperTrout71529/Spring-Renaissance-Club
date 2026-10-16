// S10: the admin page (spec §12) against the real Worker, behind a fake
// Cloudflare Access: the gate, Overview, Members → detail, System; axe on
// every screen, at both widths, in Chromium and WebKit.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { a11yViolations, signInByLink } from "./helpers";

async function asAdmin(page: Page, request: APIRequestContext, email = "felix@example.com") {
  const { jwt } = await (await request.get(`/__e2e/access-jwt?email=${encodeURIComponent(email)}`)).json();
  await page.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": jwt });
}

test("without an Access JWT, /admin and the admin API are 403", async ({ request }) => {
  expect((await request.get("/admin")).status()).toBe(403);
  expect((await request.get("/admin/admin.js")).status()).toBe(403);
  expect((await request.get("/api/admin/members")).status()).toBe(403);
});

test("an Access JWT for someone not in ADMIN_EMAILS is 403", async ({ page, request }) => {
  await asAdmin(page, request, "someone@example.com");
  const res = await page.goto("/admin");
  expect(res!.status()).toBe(403);
});

test("Overview, Members → detail, System; axe clean on each", async ({ page, request }, info) => {
  const email = `admin-view-${info.project.name}-${Date.now()}@example.com`;
  await signInByLink(page, request, email); // a member to find

  await asAdmin(page, request);
  const errors: string[] = [];
  // WebKit's own <select> rendering trips a strict style-src even on a bare
  // page (checked: <select> alone under "style-src 'self'" logs it; search
  // and date inputs do not). It is the browser's internal style, not ours.
  const webkitSelectQuirk = (t: string) => info.project.name.startsWith("webkit") && t.startsWith("Refused to apply a stylesheet because its hash");
  page.on("console", (m) => { if (m.type() === "error" && !webkitSelectQuirk(m.text())) errors.push(m.text()); });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".card").filter({ hasText: "Club accounts" })).toBeVisible();
  await expect(page.getByRole("table", { name: /Weekly totals/ })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await page.getByLabel("Email or name").fill(email);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: email })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByRole("link", { name: email }).click();
  await expect(page.getByRole("heading", { level: 1, name: email })).toBeVisible();
  await expect(page.getByRole("table", { name: "Active sessions" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "System" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Last 100 admin actions" })).toContainText("member_viewed");
  expect(await a11yViolations(page)).toEqual([]);

  expect(errors).toEqual([]); // includes CSP violations
});

test("the admin page carries a strict CSP and no framing", async ({ page, request }) => {
  await asAdmin(page, request);
  const res = await page.goto("/admin");
  const csp = res!.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res!.headers()["x-frame-options"]).toBe("DENY");
});
