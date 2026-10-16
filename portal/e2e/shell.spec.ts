// S3 acceptance: navigation per §5.4 at 375×812 and 1280×800, the #FBFBF9
// background, reduced motion, route guards and deep links.

import { expect, test } from "@playwright/test";
import { isMobile, mockOrders, mockSignedIn, mockSignedOut } from "./helpers";

test("navigation follows §5.4 on this viewport", async ({ page }) => {
  await mockSignedIn(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeVisible();
  const links = nav.getByRole("link");
  await expect(links).toHaveText(["Home", "Orders", "Saved", "Circle", "Account"]);
  await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  const box = (await nav.boundingBox())!;
  const vp = page.viewportSize()!;
  if (isMobile(page)) {
    // Bottom tab bar, 64px, full width; no sidebar extras.
    expect(Math.round(box.y + box.height)).toBe(vp.height);
    expect(Math.round(box.height)).toBe(64);
    expect(Math.round(box.width)).toBe(vp.width);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
    for (const link of await links.all()) {
      const b = (await link.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
  } else {
    // 240px left column, full height, email + Sign out at the bottom.
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(240);
    expect(Math.round(box.height)).toBe(vp.height);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(nav.getByText("clara@example.com")).toBeVisible();
    const main = (await page.locator("main").boundingBox())!;
    expect(main.width).toBeLessThanOrEqual(720);
  }
});

test("tabs navigate in-app and move aria-current", async ({ page }) => {
  await mockSignedIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Saved" }).click();
  await expect(page).toHaveURL(/\/saved$/);
  await expect(page.getByRole("heading", { level: 1, name: "Saved" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Saved" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle("Saved · Spring Renaissance");
});

test("the page background is #FBFBF9 everywhere", async ({ page }) => {
  await mockSignedOut(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  const bg = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  expect(bg).toEqual(["rgb(251, 251, 249)", "rgb(251, 251, 249)"]);

  await page.unrouteAll();
  await mockSignedIn(page);
  await mockOrders(page, { pages: [[]] });
  await page.goto("/orders");
  await expect(page.getByRole("heading", { level: 1, name: "Orders" })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(251, 251, 249)");
});

test("prefers-reduced-motion switches animation off", async ({ page }) => {
  await mockSignedIn(page);
  await page.goto("/");
  const heading = page.locator(".section-heading");
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((el) => getComputedStyle(el).animationName)).toBe("appear");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});

test("a signed-out deep link goes to /login and keeps the destination", async ({ page }) => {
  await mockSignedOut(page);
  await page.goto("/orders/1042");
  await expect(page).toHaveURL(/\/login\?return_to=%2Forders%2F1042$/);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
});

test("static routes are real pages with HTTP 200, not the 404 fallback", async ({ page }) => {
  await mockSignedIn(page);
  for (const path of ["/login", "/auth", "/orders", "/saved", "/circle", "/account", "/account/security"]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(200);
  }
});

test("deep links survive the GitHub Pages 404 fallback", async ({ page }) => {
  await mockSignedIn(page);
  await mockOrders(page, { details: {} });
  const res = await page.goto("/orders/1042");
  expect(res!.status()).toBe(404); // served by 404.html, as on Pages
  // The client router took over and asked the API for order 1042.
  await expect(page.getByRole("heading", { name: "Order not found" })).toBeVisible();
});

test("empty Orders and Saved show the spec's empty states", async ({ page }) => {
  await mockSignedIn(page);
  await mockOrders(page, { pages: [[]] });
  await page.route("**/api/wishlist**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"items":[]}' }));
  await page.goto("/orders");
  await expect(page.getByRole("heading", { level: 2, name: "No orders yet" })).toBeVisible();
  await expect(page.getByText("When you place an order with this email, it will appear here — with tracking.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Explore the collections" })).toHaveAttribute("href", "https://springrenaissance.store/collections/all");

  await page.getByRole("link", { name: "Saved" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Nothing saved yet" })).toBeVisible();
  await expect(page.getByText("Tap ♡ on any piece in the store to keep it here.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the store" })).toHaveAttribute("href", "https://springrenaissance.store");
});

test("an unknown path shows Page not found inside the shell", async ({ page }) => {
  await mockSignedIn(page);
  await page.goto("/nope");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("the CSP meta tag is present in the build", async ({ page }) => {
  await mockSignedOut(page);
  await page.goto("/login");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-src https://challenges.cloudflare.com");
});
