// S7 acceptance in the portal (§6.5): Saved | Held for you, "No longer
// available", remove, empty states, Home strips, axe; and the portal half of
// the storefront flow: sign in from a product → back on that product with
// ?sr_save=1 (the theme snippet then saves it).

import { expect, test, type Page } from "@playwright/test";
import { a11yViolations, mockOrders, mockSignedIn, stubTurnstile } from "./helpers";

const items = [
  { product_handle: "pierre-blanche", title: "Pierre Blanche", image_url: "https://cdn.shopify.com/pb.jpg", price_cents: 8800, currency: "USD", url: "https://springrenaissance.store/products/pierre-blanche", available: true },
  { product_handle: "old-vase", title: "Old Vase", image_url: null, price_cents: 4800, currency: "USD", url: null, available: false },
];
const holds = {
  holds: [{ id: "01H", kind: "object_hold", product_handle: "the-gourd", title: "The Gourd", image_url: null, created_at: "2026-10-10T10:00:00Z", status: "open" }],
  preorders: [{ order_id: "5001", name: "#1001", created_at: "2026-10-12T10:00:00Z", thumb_url: null }],
};

async function mockSaved(page: Page, { list = items, held = holds, deleteStatus = 204 } = {}) {
  const deleted: string[] = [];
  await page.route("**/api/wishlist**", async (route) => {
    const req = route.request();
    if (req.method() === "DELETE") {
      deleted.push(decodeURIComponent(new URL(req.url()).pathname.split("/").pop()!));
      return route.fulfill({ status: deleteStatus, contentType: "application/json", body: deleteStatus === 204 ? "" : JSON.stringify({ error: { code: "x", message: "x" } }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: list }) });
  });
  await page.route("**/api/holds", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(held) }));
  return deleted;
}

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    await mockSignedIn(page);
  });

  test("Saved grid: price, a link to the store, and No longer available", async ({ page }) => {
    await mockSaved(page);
    await page.goto("/saved");
    await expect(page.getByRole("tab", { name: "Saved" })).toHaveAttribute("aria-selected", "true");
    const cards = page.locator(".saved-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("$88.00");
    await expect(cards.nth(0).getByRole("link")).toHaveAttribute("href", "https://springrenaissance.store/products/pierre-blanche");
    await expect(cards.nth(1)).toContainText("No longer available");
    await expect(cards.nth(1).getByRole("link")).toHaveCount(0);
  });

  test("removing takes the piece away; a failure puts it back", async ({ page }) => {
    const deleted = await mockSaved(page);
    await page.goto("/saved");
    await page.getByRole("button", { name: "Remove Pierre Blanche from Saved" }).click();
    await expect(page.locator(".saved-card")).toHaveCount(1);
    expect(deleted).toEqual(["pierre-blanche"]);

    await page.unroute("**/api/wishlist**");
    await mockSaved(page, { deleteStatus: 500 });
    await page.reload();
    await page.getByRole("button", { name: "Remove Pierre Blanche from Saved" }).click();
    await expect(page.locator(".saved-card")).toHaveCount(2);
  });

  test("Held for you: held pieces and pre-orders; tabs work from the keyboard", async ({ page }) => {
    await mockSaved(page);
    await page.goto("/saved");
    await page.getByRole("tab", { name: "Saved" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Held for you" })).toBeFocused();
    await expect(page).toHaveURL(/\/saved\?view=held$/);
    const panel = page.getByRole("tabpanel");
    await expect(panel).toContainText("The Gourd");
    await expect(panel).toContainText("Held since Oct 10, 2026");
    await expect(panel).toContainText("We'll write when reservations open.");
    await expect(panel.getByRole("link", { name: "Order #1001 · Pre-order" })).toHaveAttribute("href", "/orders/5001");
  });

  test("empty Saved and empty Held for you", async ({ page }) => {
    await mockSaved(page, { list: [], held: { holds: [], preorders: [] } });
    await page.goto("/saved");
    await expect(page.getByRole("heading", { name: "Nothing saved yet" })).toBeVisible();
    await page.getByRole("tab", { name: "Held for you" }).click();
    await expect(page.getByRole("heading", { name: "Nothing held for you" })).toBeVisible();
  });

  test("Home shows Saved (2) and Held for you (2) with See all", async ({ page }) => {
    await mockSaved(page);
    await mockOrders(page, { pages: [[]] });
    await page.route("**/api/gift-cards", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"cards":[],"total_balance_cents":0}' }));
    await page.goto("/");
    const saved = page.getByRole("region", { name: "Saved (2)" });
    await expect(saved).toBeVisible();
    await expect(saved.locator(".saved-card")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Held for you (2)" })).toBeVisible();
    await page.getByRole("region", { name: "Held for you (2)" }).getByRole("link", { name: "See all" }).click();
    await expect(page.getByRole("tab", { name: "Held for you" })).toHaveAttribute("aria-selected", "true");
  });

  test("axe: Saved and Held for you have no WCAG 2.2 A/AA violations", async ({ page }) => {
    await mockSaved(page);
    await page.goto("/saved");
    await expect(page.locator(".saved-card")).toHaveCount(2);
    expect(await a11yViolations(page)).toEqual([]);
    await page.getByRole("tab", { name: "Held for you" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("The Gourd");
    expect(await a11yViolations(page)).toEqual([]);
  });
});

test("from a product page: sign in, and land back on the product with sr_save=1", async ({ page, request }, info) => {
  await stubTurnstile(page);
  let landed = "";
  await page.route("https://springrenaissance.store/**", (r) => {
    landed = r.request().url();
    return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Product</title><h1>Pierre Blanche</h1>" });
  });
  const email = `save-${info.project.name}-${Date.now()}@example.com`;
  const product = "https://springrenaissance.store/products/pierre-blanche?sr_save=1";
  await page.goto(`/login?return_to=${encodeURIComponent(product)}`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  const { link } = await (await request.get(`/__e2e/last-link?email=${encodeURIComponent(email)}`)).json();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Pierre Blanche" })).toBeVisible();
  expect(landed).toBe(product);
});
