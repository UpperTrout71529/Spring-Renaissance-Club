// S6 acceptance (§6.3, §6.10): greeting by the device's time of day, the
// latest active order, the gift card row (hidden without cards, last 4 only),
// the "Make it yours" card and Dismiss. API mocked.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockOrders } from "./helpers";

test.use({ timezoneId: "America/New_York" });

type MeOpts = { first_name?: string | null; passkey?: boolean; saved?: boolean; dismissed?: boolean };

async function mockMe(page: Page, opts: MeOpts = {}) {
  const state = { passkey: false, saved: false, dismissed: false, ...opts };
  const me = () => ({
    user: { id: "01USER", email: "clara@example.com", first_name: opts.first_name === undefined ? "Clara" : opts.first_name, tier: "club", created_at: "2026-10-02T09:00:00Z" },
    membership: null, badges: { circle: false },
    onboarding: { passkey: state.passkey, saved: state.saved, dismissed: state.dismissed },
  });
  const calls: string[] = [];
  await page.route("**/api/me", async (route) => {
    calls.push(route.request().method());
    if (route.request().method() === "PATCH") {
      expect(route.request().postDataJSON()).toEqual({ onboarding_dismissed: true });
      state.dismissed = true;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me()) });
  });
  return calls;
}

async function mockCards(page: Page, cards: unknown[]) {
  const total = (cards as { balance_cents: number }[]).reduce((s, c) => s + c.balance_cents, 0);
  await page.route("**/api/gift-cards", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards, total_balance_cents: total }) }));
}

const shipped = { id: "5023", name: "#1023", created_at: "2026-10-02T09:00:00Z", total_cents: 8800, currency: "USD", status: "shipped", is_preorder: false, thumb_url: null, items_count: 2 };
const shippedDetail = {
  ...shipped,
  line_items: [{ title: "Pierre Blanche", variant_title: null, qty: 1, price_cents: 8800, image_url: "https://cdn.shopify.com/p.jpg", is_preorder: false }],
  fulfillments: [{ status: "IN_TRANSIT", carrier: "UPS", tracking_number: "1Z001", tracking_url: "https://www.ups.com/track?tracknum=1Z001", shipped_at: "2026-10-03T09:00:00Z", delivered_at: null, estimated_delivery_at: "2026-10-21T16:00:00Z" }],
  shipping_city: "Brooklyn",
};

async function at(page: Page, isoUtc: string) {
  await page.clock.setFixedTime(new Date(isoUtc));
}

test("greeting follows the device's time of day; member since", async ({ page }) => {
  await mockMe(page);
  await mockOrders(page, { pages: [[]] });
  await mockCards(page, []);
  await at(page, "2026-10-16T23:30:00Z"); // 19:30 in New York
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Good evening, Clara" })).toBeVisible();
  await expect(page.getByText("Club member since Oct 2026")).toBeVisible();

  await at(page, "2026-10-16T14:00:00Z"); // 10:00 in New York
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Good morning, Clara" })).toBeVisible();
});

test("without a name the greeting is Welcome back", async ({ page }) => {
  await mockMe(page, { first_name: null });
  await mockOrders(page, { pages: [[]] });
  await mockCards(page, []);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
});

test("On its way shows the latest active order with Track parcel and its arrival date", async ({ page }) => {
  await mockMe(page);
  await mockOrders(page, { pages: [[shipped]], details: { "5023": shippedDetail } });
  await mockCards(page, []);
  await page.goto("/");
  const card = page.getByRole("region", { name: "On its way" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Pierre Blanche +1");
  await expect(card).toContainText("Shipped · Arrives Oct 21, 2026");
  await expect(card.getByRole("link", { name: "Track parcel" })).toHaveAttribute("href", "https://www.ups.com/track?tracknum=1Z001");
  await card.getByRole("link", { name: "View order" }).click();
  await expect(page).toHaveURL(/\/orders\/5023$/);
});

test("no date from Shopify → no Arrives; no active order → no card", async ({ page }) => {
  await mockMe(page);
  const noEta = { ...shippedDetail, fulfillments: [{ ...shippedDetail.fulfillments[0], estimated_delivery_at: null }] };
  await mockOrders(page, { pages: [[shipped]], details: { "5023": noEta } });
  await mockCards(page, []);
  await page.goto("/");
  const card = page.getByRole("region", { name: "On its way" });
  await expect(card).toContainText("Shipped");
  await expect(card).not.toContainText("Arrives");

  await page.unroute("**/api/orders**");
  await mockOrders(page, { pages: [[{ ...shipped, status: "delivered" }]] });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "On its way" })).toHaveCount(0);
});

test("gift card row: hidden without cards; total and last 4 only when there are some", async ({ page }) => {
  await mockMe(page);
  await mockOrders(page, { pages: [[]] });
  await mockCards(page, []);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Gift card balance")).toHaveCount(0);

  await page.unroute("**/api/gift-cards");
  await mockCards(page, [
    { last4: "K7H2", balance_cents: 4000, initial_cents: 5000, currency: "USD", expires_on: null, source: "purchased" },
    { last4: "9X2Q", balance_cents: 1250, initial_cents: 2000, currency: "USD", expires_on: "2027-10-01", source: "credits" },
  ]);
  await page.reload();
  const row = page.locator("details.home-row");
  await expect(row.locator("summary")).toContainText("Gift card balance");
  await expect(row.locator("summary")).toContainText("$52.50");
  await row.locator("summary").click();
  await expect(row.getByText("Card ending K7H2")).toBeVisible();
  await expect(row.getByText("Expires Oct 1, 2027")).toBeVisible();
});

test("Make it yours: progress, links, hidden when done, Dismiss persists", async ({ page }) => {
  const calls = await mockMe(page);
  await mockOrders(page, { pages: [[]] });
  await mockCards(page, []);
  await page.goto("/");
  const card = page.getByRole("region", { name: "Make it yours" });
  await expect(card).toContainText("1 of 3 done");
  await expect(card.getByText("Account created")).toBeVisible();
  await expect(card.getByRole("link", { name: /for faster sign-in$/ })).toHaveAttribute("href", "/account/security");
  await expect(card.getByRole("link", { name: "Save a piece you love" })).toHaveAttribute("href", "https://springrenaissance.store");

  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
  expect(calls).toContain("PATCH");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Make it yours" })).toHaveCount(0);
});

test("Make it yours disappears once every step is done", async ({ page }) => {
  await mockMe(page, { passkey: true, saved: true });
  await mockOrders(page, { pages: [[]] });
  await mockCards(page, []);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Make it yours" })).toHaveCount(0);
});

test("axe: Home has no WCAG 2.2 A/AA violations", async ({ page }) => {
  await mockMe(page);
  await mockOrders(page, { pages: [[shipped]], details: { "5023": shippedDetail } });
  await mockCards(page, [{ last4: "K7H2", balance_cents: 4000, initial_cents: 5000, currency: "USD", expires_on: null, source: "purchased" }]);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "On its way" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Make it yours" })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
