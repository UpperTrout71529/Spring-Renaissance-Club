// T18 (V2 admin): Gift pools (welcome / anniversary options, the cap and the
// budget) and the Gift queue (welcome: choose → create order; anniversary:
// skipped for budget). Shopify is not configured in e2e, so creating an order
// answers 503 — the page must say so.

import { expect, request as pwRequest, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
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

const tag = (info: TestInfo) => `${info.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function makeMember(info: TestInfo, email: string, months = 1) {
  const baseURL = String(info.project.use.baseURL);
  const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { Origin: baseURL, "X-SR-Client": "portal" } });
  expect((await ctx.post("/api/auth/magic-link", { data: { email, turnstile_token: "e2e-token" } })).status()).toBe(202);
  const { link } = await (await ctx.get(`/__e2e/last-link?email=${encodeURIComponent(email)}`)).json();
  expect((await ctx.post("/api/auth/verify", { data: { token: new URL(link).hash.replace(/^#t=/, "") } })).status()).toBe(200);
  expect((await ctx.get(`/__e2e/seed-member?email=${encodeURIComponent(email)}&months=${months}`)).status()).toBe(200);
  return ctx;
}

test("Gift pools: the seeded welcome set, add an anniversary option, the welcome cap refuses with figures, edit", async ({ page, request }, info) => {
  await request.get("/__e2e/seed-circle");
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const t = tag(info);

  await page.goto("/admin#/circle/gift-pools");
  await expect(page.getByRole("heading", { level: 1, name: "Gift pools" })).toBeVisible();
  const welcome = page.getByRole("table", { name: "Welcome pieces" });
  const bell = welcome.getByRole("row", { name: /The bell/ });
  await expect(bell).toContainText("$15.00");
  await expect(bell).toContainText("$21.00"); // + shipping S $6.00
  await expect(bell).toContainText("estimate");
  await expect(bell).toContainText("Within cap");
  await expect(page.getByText(/Anniversary budget per gift: \$0\.00/)).toBeVisible();
  expect(await a11y(page)).toEqual([]);

  const form = page.getByRole("form", { name: "Add an option" });
  await form.getByLabel("Pool").selectOption("anniversary");
  await form.getByLabel("Title").fill(`Bookend ${t}`);
  await form.getByLabel("Blurb").fill("A small brass bookend.");
  await form.getByLabel("Shopify variant id").fill("123456");
  await form.getByLabel("Landed cost ($)").fill("12.00");
  await form.getByLabel("Shipping class").selectOption("S");
  await form.getByLabel("Active").check();
  await form.getByRole("button", { name: "Save option" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Option saved." })).toBeVisible();
  const row = page.getByRole("table", { name: "Anniversary options" }).getByRole("row", { name: new RegExp(`Bookend ${t}`) });
  await expect(row).toContainText("gid://shopify/ProductVariant/123456");
  await expect(row).toContainText("Over budget");

  // Welcome: $20.00 + S $6.00 > $25.00 → refused with the figures, the form keeps its values.
  const add = page.getByRole("form", { name: "Add an option" });
  await add.getByLabel("Pool").selectOption("welcome");
  await add.getByLabel("Title").fill(`Too dear ${t}`);
  await add.getByLabel("Shopify variant id").fill("gid://shopify/ProductVariant/77");
  await add.getByLabel("Landed cost ($)").fill("20.00");
  await add.getByLabel("Shipping class").selectOption("S");
  await add.getByLabel("Active").check();
  await add.getByRole("button", { name: "Save option" }).click();
  const alert = add.getByRole("alert");
  await expect(alert).toContainText("With shipping this piece costs more than the welcome cap.");
  await expect(alert).toContainText("Landed cost $20.00 + shipping $6.00 = $26.00");
  await expect(alert).toContainText("cap $25.00");
  await expect(add.getByLabel("Title")).toHaveValue(`Too dear ${t}`);
  expect(await a11y(page)).toEqual([]);

  await page.getByRole("table", { name: "Anniversary options" }).getByRole("row", { name: new RegExp(`Bookend ${t}`) })
    .getByRole("button", { name: /Edit/ }).click();
  const edit = page.getByRole("form", { name: `Edit Bookend ${t}` });
  await expect(edit.getByLabel("Title")).toHaveValue(`Bookend ${t}`);
  await expect(edit.getByLabel("Title")).toBeFocused();
  await edit.getByLabel("Sort").fill("7");
  await edit.getByRole("button", { name: "Save option" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Option saved." })).toBeVisible();
  await expect(page.getByRole("table", { name: "Anniversary options" }).getByRole("row", { name: new RegExp(`Bookend ${t}`) })).toContainText("7");
  expect(errors).toEqual([]);
});

test("Gift queue: a chosen welcome piece → Create order (confirmed) says Shopify is not connected; anniversary skipped for budget", async ({ page, request }, info) => {
  const t = tag(info);
  const chose = `queue-chose-${t}@example.com`;
  const waits = `queue-waits-${t}@example.com`;
  const year = `queue-year-${t}@example.com`;
  const member = await makeMember(info, chose);
  expect((await member.post("/api/circle/welcome", { data: { gift_option_id: "gw_e2e_1" } })).status()).toBe(200);
  await makeMember(info, waits);
  await makeMember(info, year, 13);
  await asAdmin(page, request);
  const errors = watchErrors(page, info);

  await page.goto("/admin#/circle/gift-queue");
  await expect(page.getByRole("heading", { level: 1, name: "Gift queue" })).toBeVisible();
  const welcome = page.getByRole("table", { name: "Welcome queue" });
  const waiting = welcome.getByRole("row", { name: new RegExp(waits) });
  await expect(waiting).toContainText("Awaiting choice");
  await expect(waiting).toContainText("The member can choose for 14 more days");
  const chosen = welcome.getByRole("row", { name: new RegExp(chose) });
  await expect(chosen).toContainText("Chosen");
  await expect(chosen).toContainText("The bell");
  const anniversary = page.getByRole("table", { name: "Anniversary queue" }).getByRole("row", { name: new RegExp(year) });
  await expect(anniversary).toContainText("Skipped (budget)");
  await expect(anniversary).toContainText("budget was $0.00");
  expect(await a11y(page)).toEqual([]);

  page.once("dialog", (d) => d.dismiss());
  await chosen.getByRole("button", { name: /Create order/ }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  page.once("dialog", (d) => { expect(d.message()).toContain(chose); d.accept(); });
  await chosen.getByRole("button", { name: /Create order/ }).click();
  await expect(page.getByRole("alert")).toContainText("Shopify is not connected here");
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Gift queue: assign a welcome piece after 14 days, an anniversary gift only within its budget, then create the order", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const sent: { path: string; body: unknown; client: string | undefined }[] = [];
  const queue = {
    welcome: [{ id: "GS1", status: "awaiting_choice", email: "late@example.com", name: "Late Chooser", option_title: null, has_address: true,
      needs_attention: false, days_waiting: 15, can_assign: true, shopify_order_gid: null }],
    anniversary: [{ id: "AG1", n: 1, status: "ready", reason: null, budget_cents: 1500, has_address: true, created_at: "2026-10-01T10:00:00Z",
      shopify_order_gid: null, email: "year@example.com", option_title: null }],
  };
  const options = {
    anniversary_budget_cents: 1500,
    options: [
      { id: "W1", kind: "welcome", title: "The bell", active: true, within_cap: true, landed_cost_cents: 1500, shipping_cents: 600, shipping_class: "S", sort: 0 },
      { id: "W2", kind: "welcome", title: "Over the cap", active: true, within_cap: false, landed_cost_cents: 2400, shipping_cents: 600, shipping_class: "S", sort: 1 },
      { id: "A1", kind: "anniversary", title: "Small bookend", active: true, within_budget: true, landed_cost_cents: 800, shipping_cents: 600, shipping_class: "S", sort: 0 },
      { id: "A2", kind: "anniversary", title: "Large bookend", active: true, within_budget: false, landed_cost_cents: 1200, shipping_cents: 600, shipping_class: "S", sort: 1 },
    ],
  };
  await page.route("**/api/admin/gift-options**", (r) => r.fulfill({ json: options }));
  await page.route("**/api/admin/gift-queue", (r) => r.fulfill({ json: queue }));
  await page.route(/\/api\/admin\/(gift-queue|anniversary)\/[^/]+\/(assign|create-order)$/, (r) => {
    const path = new URL(r.request().url()).pathname;
    sent.push({ path, body: r.request().postDataJSON(), client: r.request().headers()["x-sr-client"] });
    if (path === "/api/admin/gift-queue/GS1/assign") Object.assign(queue.welcome[0], { status: "chosen", option_title: "The bell", can_assign: false });
    if (path === "/api/admin/anniversary/AG1/assign") Object.assign(queue.anniversary[0], { option_title: "Small bookend" });
    if (path.endsWith("/create-order")) {
      Object.assign(queue.anniversary[0], { status: "order_created", shopify_order_gid: "gid://shopify/Order/555" });
      return r.fulfill({ json: { status: "order_created", shopify_order_gid: "gid://shopify/Order/555" } });
    }
    return r.fulfill({ json: { status: "chosen", assigned: true } });
  });

  await page.goto("/admin#/circle/gift-queue");
  const late = page.getByRole("table", { name: "Welcome queue" }).getByRole("row", { name: /late@example.com/ });
  const piece = late.getByRole("combobox", { name: "Piece for late@example.com" });
  await expect(piece.locator("option")).toHaveText(["Choose…", "The bell"]); // not the one over the cap
  await late.getByRole("button", { name: /Assign/ }).click();
  await expect(page.getByRole("alert")).toContainText("Choose a piece for late@example.com first.");
  await piece.selectOption("W1");
  await late.getByRole("button", { name: /Assign/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Assigned for late@example.com." })).toBeVisible();
  await expect(page.getByRole("table", { name: "Welcome queue" }).getByRole("row", { name: /late@example.com/ })).toContainText("The bell");

  const year = () => page.getByRole("table", { name: "Anniversary queue" }).getByRole("row", { name: /year@example.com/ });
  await expect(year().getByRole("combobox", { name: "Piece for year@example.com" }).locator("option")).toHaveText(["Choose…", "Small bookend"]);
  await year().getByRole("combobox", { name: "Piece for year@example.com" }).selectOption("A1");
  await year().getByRole("button", { name: /Assign/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Assigned for year@example.com." })).toBeVisible();
  expect(await a11y(page)).toEqual([]);
  page.once("dialog", (d) => d.accept());
  await year().getByRole("button", { name: /Create order/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Order created for year@example.com." })).toBeVisible();
  await expect(year()).toContainText("gid://shopify/Order/555");
  expect(sent).toEqual([
    { path: "/api/admin/gift-queue/GS1/assign", body: { gift_option_id: "W1" }, client: "admin" },
    { path: "/api/admin/anniversary/AG1/assign", body: { gift_option_id: "A1" }, client: "admin" },
    { path: "/api/admin/anniversary/AG1/create-order", body: {}, client: "admin" },
  ]);
  expect(errors).toEqual([]);
});
