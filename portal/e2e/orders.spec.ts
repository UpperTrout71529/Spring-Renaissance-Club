// S5 acceptance in the portal (§6.4): list with Load more, detail with every
// tracking number, no invented dates, help mailto, 404 and error states, axe.

import { expect, test } from "@playwright/test";
import { a11yViolations, mockOrders, mockSignedIn } from "./helpers";

const summary = (n: number, extra: Record<string, unknown> = {}) => ({
  id: String(5000 + n), name: `#${1000 + n}`, created_at: "2026-10-02T09:00:00Z", total_cents: 8800, currency: "USD",
  status: "processing", is_preorder: false, thumb_url: `https://cdn.shopify.com/p${n}.jpg`, items_count: 1, ...extra,
});

const pages = [
  Array.from({ length: 10 }, (_, i) => summary(23 - i, i === 0 ? { status: "shipped", items_count: 3, total_cents: 123450 } : {})),
  Array.from({ length: 10 }, (_, i) => summary(13 - i)),
  Array.from({ length: 3 }, (_, i) => summary(3 - i, i === 0 ? { status: "delivered" } : {})),
];

const split = {
  ...summary(23, { status: "shipped", items_count: 3, total_cents: 123450 }),
  financial_status: "PAID", fulfillment_status: "PARTIALLY_FULFILLED",
  line_items: [{ title: "Pierre Blanche", variant_title: "Chalk", qty: 3, price_cents: 41150, image_url: "https://cdn.shopify.com/p23.jpg", is_preorder: false }],
  fulfillments: [
    { status: "IN_TRANSIT", carrier: "UPS", tracking_number: "1Z001", tracking_url: "https://www.ups.com/track?tracknum=1Z001", shipped_at: "2026-10-03T09:00:00Z", delivered_at: null, estimated_delivery_at: "2026-10-21T12:00:00Z" },
    { status: "IN_TRANSIT", carrier: "UPS", tracking_number: "1Z002", tracking_url: "https://www.ups.com/track?tracknum=1Z002", shipped_at: "2026-10-03T09:00:00Z", delivered_at: null, estimated_delivery_at: "2026-10-21T12:00:00Z" },
    { status: "FULFILLED", carrier: "USPS", tracking_number: "9400", tracking_url: null, shipped_at: "2026-10-04T09:00:00Z", delivered_at: null, estimated_delivery_at: null },
  ],
  shipping_city: "Brooklyn",
};

test.beforeEach(async ({ page }) => {
  await mockSignedIn(page);
});

test("the list pages with Load more and shows the §6.4 labels", async ({ page }) => {
  await mockOrders(page, { pages });
  await page.goto("/orders");
  const cards = page.locator(".order-card");
  await expect(cards).toHaveCount(10);
  await expect(cards.first()).toContainText("#1023");
  await expect(cards.first()).toContainText("Shipped");
  await expect(cards.first()).toContainText("+2");
  await expect(cards.first()).toContainText("$1,234.50");
  await expect(cards.first().locator("img")).toHaveAttribute("src", "https://cdn.shopify.com/p23.jpg?width=160");
  await expect(cards.nth(1)).toContainText("Processing");

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(cards).toHaveCount(20);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(cards).toHaveCount(23);
  await expect(cards.last()).toContainText("#1001");
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(page.getByText("Delivered")).toBeVisible();
});

test("detail: every tracking number, Track with {Carrier}, an arrival date only when Shopify has one", async ({ page }) => {
  await mockOrders(page, { pages, details: { "5023": split } });
  await page.goto("/orders");
  await page.locator(".order-card").first().click();
  await expect(page).toHaveURL(/\/orders\/5023$/);
  await expect(page.getByRole("heading", { level: 1, name: "#1023" })).toBeVisible();

  for (const n of ["1Z001", "1Z002", "9400"]) await expect(page.getByText(`Tracking number ${n}`)).toBeVisible();
  const track = page.getByRole("link", { name: "Track with UPS" });
  await expect(track).toHaveCount(2);
  await expect(track.first()).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("link", { name: /Track with USPS|Track parcel/ })).toHaveCount(0); // no URL from Shopify
  // Two parcels have an estimate, the USPS one has none — so exactly two "Arrives" lines.
  await expect(page.getByText(/^Arrives /)).toHaveCount(2);
  await expect(page.getByText("Shipping to Brooklyn")).toBeVisible();
  await expect(page.getByText("$1,234.50").last()).toBeVisible();

  const help = page.getByRole("link", { name: "Need help with this order?" });
  await expect(help).toHaveAttribute("href", "mailto:concierge@springrenaissance.store?subject=Order%20%231023");

  expect(await a11yViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Back to orders" }).click();
  await expect(page).toHaveURL(/\/orders$/);
});

test("someone else's order shows Order not found", async ({ page }) => {
  await mockOrders(page, { details: {} });
  await page.goto("/orders/5099");
  await expect(page.getByRole("heading", { name: "Order not found" })).toBeVisible();
});

test("a failure shows the error state with Try again", async ({ page }) => {
  await mockOrders(page, { status: 503 });
  await page.goto("/orders");
  await expect(page.getByRole("alert")).toContainText("We couldn't load your orders right now.");
  await page.unroute("**/api/orders**");
  await mockOrders(page, { pages });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".order-card")).toHaveCount(10);
});

test("axe: the orders list has no WCAG 2.2 A/AA violations", async ({ page }) => {
  await mockOrders(page, { pages });
  await page.goto("/orders");
  await expect(page.locator(".order-card")).toHaveCount(10);
  expect(await a11yViolations(page)).toEqual([]);
});
