// T18 (V2 admin): Economics (settings, computed figures for both card
// profiles, the invitation check, needs-data) and Costs & Circle price
// (catalog variants, cost entry with the zero confirmation, the list, sync
// buttons and the member-price sync status). Shopify is not configured in e2e,
// so the catalog is empty on the real Worker; the variant table is checked
// against a fixture, and what the page sends is asserted.

import { expect, test, type APIRequestContext, type Page, type Request, type TestInfo } from "@playwright/test";
import { a11yViolations } from "./helpers";

// axe, plus reflow: the page itself never scrolls sideways (tables scroll
// inside their own focusable region).
async function a11y(page: Page) {
  const violations = await a11yViolations(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  return sideways ? [...violations, "page scrolls sideways"] : violations;
}

async function asAdmin(page: Page, request: APIRequestContext) {
  const { jwt } = await (await request.get("/__e2e/access-jwt")).json();
  await page.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": jwt });
}

function watchErrors(page: Page, info: TestInfo) {
  const errors: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error" || /Failed to load resource/.test(t)) return;
    if (info.project.name.startsWith("webkit") && t.startsWith("Refused to apply a stylesheet because its hash")) return;
    errors.push(t);
  });
  return errors;
}

const writeHeaders = (r: Request) => {
  const hd = r.headers();
  return { type: hd["content-type"], client: hd["x-sr-client"] };
};

test("Economics: figures for both profiles, needs data, the invitation check; saving shipping", async ({ page, request }, info) => {
  await request.get("/__e2e/seed-circle");
  await asAdmin(page, request);
  const errors = watchErrors(page, info);

  await page.goto("/admin#/circle/economics");
  await expect(page.getByRole("heading", { level: 1, name: "Economics" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Circle" }).getByRole("link", { name: "Economics" })).toHaveAttribute("aria-current", "page");
  const needs = page.getByRole("list", { name: "Needs data from Felix" });
  await expect(needs).toContainText("catalog (run the Shopify sync)");
  const profiles = page.getByRole("table", { name: "Per member, by card profile" });
  await expect(profiles).toContainText("Monthly net");
  await expect(profiles).toContainText("$18.98"); // §12.2: $20 → net $18.98 (expected profile)
  await expect(profiles).toContainText("Joining net, with invitation");
  await expect(profiles).toContainText("Anniversary budget");
  await expect(page.getByRole("region", { name: "Invitation check" })).toContainText("Needs cost data");
  await expect(page.getByRole("region", { name: "Cost per credit-dollar" })).toBeVisible();
  // Shipping S is seeded as an estimate.
  await expect(page.getByRole("checkbox", { name: "Shipping S is an estimate" })).toBeChecked();
  await expect(page.getByLabel("Shipping S ($)")).toHaveValue("6.00");
  await expect(page.locator("details").filter({ hasText: "Fees" })).not.toHaveAttribute("open", "");
  expect(await a11y(page)).toEqual([]);

  // Each project its own value, so both runs really change something.
  const m = info.project.name.startsWith("webkit") ? "9.75" : "9.50";
  await page.getByLabel("Shipping M ($)").fill(m);
  await page.getByRole("checkbox", { name: "Shipping M is an estimate" }).check();
  const put = page.waitForRequest((r) => r.url().endsWith("/api/admin/economics") && r.method() === "PUT");
  await page.getByRole("button", { name: "Save settings" }).click();
  const sent = await put;
  expect(writeHeaders(sent)).toEqual({ type: "application/json", client: "admin" });
  expect(sent.postDataJSON().changes.shipping.M).toEqual({ cents: Math.round(Number(m) * 100), estimate: true });
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  await expect(page.getByLabel("Shipping M ($)")).toHaveValue(m);
  await expect(page.getByRole("list", { name: "Estimates in use" })).toContainText("shipping M");
  expect(errors).toEqual([]);
});

test("Economics: a refused save (rule 3) shows the terms and keeps the form", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  await page.route("**/api/admin/economics", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    return route.fulfill({ status: 422, json: {
      error: { code: "economics_rule_failed", message: "These values would make an invitation cost more than it brings." },
      explanation: {
        ok: false, reason: "invitation_costs_more_than_it_brings",
        terms: { lhs_cents: 3812, rhs_cents: 2950, discount_cents: 3000, reward_cents: 1000, reward_cost_cents: 792, giftcard_fee_cents: 20,
          joining_net_cents: 2892, welcome_cost_cents: 1800, shipping_cents: 600, monthly_contribution_cents: 1229, cost_per_credit_ppm: 791200 },
        max_reward_cents: 0, max_discount_cents: 2138,
      },
    } });
  });
  await page.goto("/admin#/circle/economics");
  await page.getByLabel("Friend's discount ($)").fill("30");
  await page.getByRole("button", { name: "Save settings" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("These values would make an invitation cost more than it brings.");
  await expect(alert).toContainText("Cost of an invitation: $38.12");
  await expect(alert).toContainText("Value of an invitation: $29.50");
  await expect(alert).toContainText("Largest reward at this discount: 0 credits");
  await expect(alert).toContainText("Largest discount at this reward: $21.38");
  await expect(page.getByLabel("Friend's discount ($)")).toHaveValue("30");
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Costs & Circle price on the real Worker: empty catalog, sync buttons answer, sync status", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  await page.goto("/admin#/circle/costs");
  await expect(page.getByRole("heading", { level: 1, name: "Costs & Circle price" })).toBeVisible();
  await expect(page.getByText("No variants yet — run the catalog sync.")).toBeVisible();
  const status = page.getByRole("region", { name: "Member price in Shopify" });
  await expect(status).toContainText("Off");
  expect(await a11y(page)).toEqual([]);

  await page.getByRole("button", { name: "Sync catalog from Shopify" }).click();
  await expect(page.getByRole("alert")).toContainText("Shopify is not connected here");
  await page.getByRole("button", { name: "Sync member price now" }).click();
  await expect(page.getByRole("alert")).toContainText("The member price sync is switched off (CIRCLE_PRICE_SYNC).");
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});

const VARIANTS = [
  { variant_gid: "gid://shopify/ProductVariant/11", product_gid: "gid://shopify/Product/1", handle: "the-kouros-fragment", title: "The Kouros Fragment — Small",
    price_cents: 22000, status: "ACTIVE", published: true, exclusion: null, cost_cents: 8000, zero_confirmed: false, shipping_class: "M", on_list: true,
    eligible: true, reason: null, circle_price_cents: 16500, max_cost_cents: 9100, shipping_estimate: true },
  { variant_gid: "gid://shopify/ProductVariant/12", product_gid: "gid://shopify/Product/1", handle: "the-kouros-fragment", title: "The Kouros Fragment — Large",
    price_cents: 39500, status: "ACTIVE", published: true, exclusion: null, cost_cents: null, zero_confirmed: false, shipping_class: null, on_list: false,
    eligible: false, reason: "not_on_list", circle_price_cents: null, max_cost_cents: null, shipping_estimate: null },
  { variant_gid: "gid://shopify/ProductVariant/21", product_gid: "gid://shopify/Product/2", handle: "brass-bell", title: "Brass bell",
    price_cents: 4000, status: "ACTIVE", published: true, exclusion: "catalog", cost_cents: null, zero_confirmed: false, shipping_class: "S", on_list: false,
    eligible: false, reason: "excluded_catalog", circle_price_cents: null, max_cost_cents: null, shipping_estimate: null },
];

test("Costs & Circle price: variant table, zero cost asks first, list toggles per variant and per product", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const puts: { path: string; body: unknown; headers: ReturnType<typeof writeHeaders> }[] = [];
  const searches: string[] = [];
  await page.route("**/api/admin/costs**", (route) => {
    const r = route.request();
    if (r.method() === "PUT") {
      puts.push({ path: "costs", body: r.postDataJSON(), headers: writeHeaders(r) });
      return route.fulfill({ json: { saved: true, item: { eligible: false, reason: "margin_below_min", circle_price_cents: null, max_cost_cents: 9100 } } });
    }
    const q = new URL(r.url()).searchParams.get("q") || "";
    searches.push(q);
    const list = VARIANTS.filter((v) => !q || v.handle.includes(q));
    return route.fulfill({ json: { variants: list, shipping: { S: { cents: 600, estimate: true }, M: { cents: 950, estimate: true }, L: { cents: null, estimate: true } } } });
  });
  await page.route("**/api/admin/circle-price/list", (route) => {
    const r = route.request();
    puts.push({ path: "list", body: r.postDataJSON(), headers: writeHeaders(r) });
    return route.fulfill({ json: { saved: true, variants: 1 } });
  });

  await page.goto("/admin#/circle/costs");
  const table = page.getByRole("table", { name: "Catalog variants" });
  const small = table.getByRole("row", { name: /The Kouros Fragment — Small/ });
  await expect(small).toContainText("$220.00");
  await expect(small).toContainText("$165.00");
  await expect(small).toContainText("$91.00");
  await expect(small).toContainText("estimate");
  await expect(table.getByRole("row", { name: /Brass bell/ })).toContainText("Small Pleasures");
  await expect(table.getByRole("row", { name: /The Kouros Fragment — Large/ })).toContainText("Not on the list");
  await expect(page.getByText(/Shipping: S \$6\.00 \(estimate\)/)).toBeVisible();
  expect(await a11y(page)).toEqual([]);

  // Zero cost: the confirmation first; declined → nothing sent.
  const large = table.getByRole("row", { name: /The Kouros Fragment — Large/ });
  await large.getByLabel(/Cost/).fill("0");
  await large.getByLabel(/Shipping class/).selectOption("L");
  page.once("dialog", (d) => d.dismiss());
  await large.getByRole("button", { name: /Save/ }).click();
  await expect(page.getByRole("alert")).toContainText("Not saved");
  expect(puts).toEqual([]);
  page.once("dialog", (d) => { expect(d.message()).toContain("zero"); d.accept(); });
  await table.getByRole("row", { name: /The Kouros Fragment — Large/ }).getByRole("button", { name: /Save/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cost saved" })).toBeVisible();
  expect(puts[0]).toEqual({ path: "costs", headers: { type: "application/json", client: "admin" },
    body: { variant_gid: "gid://shopify/ProductVariant/12", cost_cents: 0, zero_confirmed: true, shipping_class: "L" } });

  // Empty = not participating.
  await table.getByRole("row", { name: /The Kouros Fragment — Small/ }).getByLabel(/Cost/).fill("");
  await table.getByRole("row", { name: /The Kouros Fragment — Small/ }).getByRole("button", { name: /Save/ }).click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1].body).toEqual({ variant_gid: "gid://shopify/ProductVariant/11", cost_cents: null, shipping_class: "M" });

  await table.getByRole("checkbox", { name: /On the list: The Kouros Fragment — Large/ }).check();
  await expect.poll(() => puts.length).toBe(3);
  expect(puts[2]).toEqual({ path: "list", headers: { type: "application/json", client: "admin" }, body: { variant_gid: "gid://shopify/ProductVariant/12", on_list: true } });
  await table.getByRole("button", { name: /Put every variant of the-kouros-fragment on the list/ }).click();
  await expect.poll(() => puts.length).toBe(4);
  expect(puts[3].body).toEqual({ product_gid: "gid://shopify/Product/1", on_list: true });

  await page.getByLabel("Search the catalog").fill("brass");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(table.getByRole("row", { name: /Brass bell/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Kouros/ })).toHaveCount(0);
  expect(searches.at(-1)).toBe("brass");
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});
