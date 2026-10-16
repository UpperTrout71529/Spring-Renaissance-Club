// S8 acceptance (§6.3, §6.6): the teaser always below the useful blocks, no
// modals, the spec's copy, Circle price lines from real prices, Reserve a
// place (once), Not now → one line, the /circle screen, axe.

import { expect, test, type Page } from "@playwright/test";
import { a11yViolations, mockOrders, mockSignedIn } from "./helpers";

type TeaserState = { snoozed_until: string | null; on_waitlist: boolean; examples?: unknown[] };

async function mockHome(page: Page, teaser: TeaserState) {
  const calls = { waitlist: 0, patch: [] as unknown[] };
  await page.route("**/api/me", async (route) => {
    if (route.request().method() === "PATCH") {
      calls.patch.push(route.request().postDataJSON());
      teaser.snoozed_until = "2026-11-15T12:00:00.000Z";
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      user: { id: "01USER", email: "clara@example.com", first_name: "Clara", tier: "club", created_at: "2026-10-02T09:00:00Z" },
      membership: null, badges: { circle: false }, onboarding: { passkey: true, saved: true, dismissed: false },
    }) });
  });
  await page.route("**/api/circle/teaser", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    sealed_count: 0, show_count: false, member_price_examples: teaser.examples ?? [], snoozed_until: teaser.snoozed_until, on_waitlist: teaser.on_waitlist,
  }) }));
  await page.route("**/api/circle/waitlist", (r) => {
    calls.waitlist++;
    teaser.on_waitlist = true;
    return r.fulfill({ status: 201, contentType: "application/json", body: '{"on_waitlist":true}' });
  });
  await page.route("**/api/gift-cards", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"cards":[],"total_balance_cents":0}' }));
  await page.route("**/api/wishlist**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [
    { product_handle: "pierre-blanche", title: "Pierre Blanche", image_url: null, price_cents: 8800, currency: "USD", url: null, available: true },
  ] }) }));
  await page.route("**/api/holds", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
    teaser.on_waitlist
      ? { holds: [{ id: "01W", kind: "circle_waitlist", product_handle: null, title: null, image_url: null, created_at: "2026-10-16T10:00:00Z", status: "open" }], preorders: [] }
      : { holds: [], preorders: [] },
  ) }));
  const shipped = { id: "5023", name: "#1023", created_at: "2026-10-02T09:00:00Z", total_cents: 8800, currency: "USD", status: "shipped", is_preorder: false, thumb_url: null, items_count: 1 };
  await mockOrders(page, { pages: [[shipped]], details: { "5023": { ...shipped, line_items: [{ title: "Pierre Blanche", image_url: null }], fulfillments: [], shipping_city: null } } });
  return calls;
}

test("the teaser sits below the useful blocks, with the spec's copy and no modal", async ({ page }) => {
  await mockHome(page, { snoozed_until: null, on_waitlist: false, examples: [{ handle: "pierre-blanche", title: "Pierre Blanche", price_cents: 8800, member_price_cents: 6600 }] });
  await page.goto("/");
  const teaser = page.getByRole("region", { name: "A sealed object, chosen by you." });
  await expect(teaser).toBeVisible();
  await expect(teaser).toContainText("Members choose their first piece from a small sealed selection — revealed only after joining.");
  await expect(teaser).toContainText("$20 a month becomes 20 credits to spend on anything in the house, plus 25% off our collections.");
  await expect(teaser).toContainText("With the Circle, Pierre Blanche would be $66.00.");
  await expect(teaser).toContainText("Opening soon");
  await expect(teaser.getByRole("link", { name: "Learn about the Circle" })).toHaveAttribute("href", "/circle");

  const below = (await teaser.boundingBox())!.y;
  for (const name of ["On its way", "Saved (1)"]) {
    const box = (await page.getByRole("region", { name }).boundingBox())!;
    expect(box.y).toBeLessThan(below);
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Reserve a place: one request, then the spec's confirmation", async ({ page }) => {
  const calls = await mockHome(page, { snoozed_until: null, on_waitlist: false });
  await page.goto("/");
  const teaser = page.getByRole("region", { name: "A sealed object, chosen by you." });
  await teaser.getByRole("button", { name: "Reserve a place" }).click();
  await expect(teaser.getByText("You're on the list. We'll write once, when the Circle opens.")).toBeVisible();
  await expect(teaser.getByRole("button", { name: "Reserve a place" })).toHaveCount(0);
  expect(calls.waitlist).toBe(1);

  await page.goto("/saved?view=held");
  await expect(page.getByRole("tabpanel")).toContainText("A place in the Circle");
});

test("Not now folds the teaser to one line, and it stays folded", async ({ page }) => {
  const calls = await mockHome(page, { snoozed_until: null, on_waitlist: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Not now" }).click();
  expect(calls.patch).toEqual([{ circle_teaser_snooze: true }]);
  await expect(page.getByRole("region", { name: "A sealed object, chosen by you." })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "The Renaissance Circle · Opening soon" })).toHaveAttribute("href", "/circle");
  await page.reload();
  await expect(page.getByRole("link", { name: "The Renaissance Circle · Opening soon" })).toBeVisible();
  await expect(page.getByRole("region", { name: "A sealed object, chosen by you." })).toHaveCount(0);
});

test("/circle: how it works, five questions, Reserve a place; axe clean", async ({ page }) => {
  await mockSignedIn(page);
  await page.route("**/api/circle/teaser", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    sealed_count: 0, show_count: false, member_price_examples: [], snoozed_until: null, on_waitlist: false,
  }) }));
  await page.goto("/circle");
  await expect(page.getByRole("heading", { level: 1, name: "A sealed object, chosen by you." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Circle" })).toHaveAttribute("aria-current", "page");
  const steps = page.locator(".circle-steps li");
  await expect(steps).toHaveText(["Join for $50", "Choose your sealed piece", "$20 a month becomes 20 credits"]);
  const faq = page.locator(".circle-faq details");
  await expect(faq).toHaveCount(5);
  await faq.nth(3).locator("summary").click();
  await expect(faq.nth(3)).toContainText("They stay usable for 30 days after the end of your last paid month, then they expire.");
  await expect(page.getByRole("button", { name: "Reserve a place" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
});

test("axe: Home with the teaser has no WCAG 2.2 A/AA violations", async ({ page }) => {
  await mockHome(page, { snoozed_until: null, on_waitlist: false, examples: [{ handle: "pierre-blanche", title: "Pierre Blanche", price_cents: 8800, member_price_cents: 6600 }] });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "A sealed object, chosen by you." })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
});
