// S11 security pass: what a member types (their name) is shown as text
// everywhere — Home greeting, Account form, the admin's member list — and
// never runs. The payload would set window.__xss if it executed.

import { expect, test } from "@playwright/test";
import { mockOrders, signInByLink } from "./helpers";

const PAYLOAD = `<img src=x onerror="window.__xss=1">`;

test("portal: a name with HTML in it renders as text on Home and Account", async ({ page }) => {
  await page.route("**/api/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    user: { id: "01USER", email: "clara@example.com", first_name: PAYLOAD, last_name: "</h1><script>window.__xss=1</script>", tier: "club", created_at: "2026-10-02T09:00:00Z", seasonal_email_opt_in: false },
    membership: null, badges: { circle: false }, onboarding: { passkey: true, saved: true, dismissed: true },
  }) }));
  await page.route("**/api/gift-cards", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"cards":[],"total_balance_cents":0}' }));
  await mockOrders(page, { pages: [[]] });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(PAYLOAD);
  await page.goto("/account");
  await expect(page.getByLabel("First name")).toHaveValue(PAYLOAD);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("admin: a member's HTML name shows as text in Members and the detail", async ({ page, request }, info) => {
  const email = `xss-${info.project.name}-${Date.now()}@example.com`;
  await signInByLink(page, request, email);
  const status = await page.evaluate(async (name) => (await fetch("/api/me", {
    method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json", "X-SR-Client": "portal" },
    body: JSON.stringify({ first_name: name }),
  })).status, PAYLOAD);
  expect(status).toBe(200);

  const { jwt } = await (await request.get("/__e2e/access-jwt")).json();
  await page.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": jwt });
  await page.goto(`/admin#/members?q=${encodeURIComponent(email)}`);
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText(PAYLOAD);
  await row.getByRole("link", { name: email }).click();
  await expect(page.getByText(PAYLOAD).first()).toBeVisible();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});
