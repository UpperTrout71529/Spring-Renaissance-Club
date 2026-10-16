// T18 (V2 admin): Members' object releases (draft → open with the 422
// explanations → guard), Capsules (create, close) and Invitations (review
// queue: credit / reject). Shopify is not configured in e2e: the guard answers
// "not connected"; the review state cannot be reached without a catalog, so
// the review queue is checked against a fixture and what the page sends.

import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
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

test("Members' object: a draft, Open explains what is missing, then the minimum price, then the guard", async ({ page, request }, info) => {
  await request.get("/__e2e/seed-circle"); // shipping S
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const label = `Vase ${tag(info)}`;

  await page.goto("/admin#/circle/object");
  await expect(page.getByRole("heading", { level: 1, name: "Members' object" })).toBeVisible();
  expect(await a11y(page)).toEqual([]);

  const form = page.getByRole("form", { name: "New release" });
  await form.getByLabel("Label (admin only)").fill(label);
  await form.getByLabel("Shopify product id").fill("111");
  await form.getByLabel("Shopify variant id").fill("222");
  await form.getByRole("button", { name: "Save release" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Release saved." })).toBeVisible();
  const row = () => page.getByRole("table", { name: "Releases" }).getByRole("row", { name: new RegExp(label) });
  await expect(row()).toContainText("Draft");
  await expect(row()).toContainText("Members' object");

  await row().getByRole("button", { name: /^Open/ }).click();
  let alert = page.getByRole("alert");
  await expect(alert).toContainText("Fill in every figure before opening.");
  await expect(alert).toContainText("Missing: price, edition size, unit cost, shipping class, reservation hours, opens, closes");
  expect(await a11y(page)).toEqual([]);

  await row().getByRole("button", { name: /^Edit/ }).click();
  const edit = page.getByRole("form", { name: `Edit ${label}` });
  await edit.getByLabel("Price ($)").fill("30.00");
  await edit.getByLabel("Edition size").fill("12");
  await edit.getByLabel("Unit cost ($)").fill("20.00");
  await edit.getByLabel("Shipping class").selectOption("S");
  await edit.getByLabel("Reservation (hours)").fill("48");
  await edit.getByLabel("Opens (UTC)").fill("2026-11-01T10:00");
  await edit.getByLabel("Closes (UTC)").fill("2026-11-08T10:00");
  await edit.getByRole("button", { name: "Save release" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Release saved." })).toBeVisible();
  await expect(row()).toContainText("$30.00");
  await expect(row()).toContainText("12");

  await row().getByRole("button", { name: /^Open/ }).click();
  alert = page.getByRole("alert");
  await expect(alert).toContainText("At this price the piece would not keep the minimum margin.");
  await expect(alert).toContainText(/Minimum price: \$\d+\.\d\d/);
  await expect(alert).toContainText("shipping $6.00 (estimate)");

  await row().getByRole("button", { name: /^Edit/ }).click();
  await page.getByRole("form", { name: `Edit ${label}` }).getByLabel("Price ($)").fill("80.00");
  await page.getByRole("form", { name: `Edit ${label}` }).getByRole("button", { name: "Save release" }).click();
  await expect(row()).toContainText("$80.00");
  await row().getByRole("button", { name: /^Open/ }).click();
  await expect(page.getByRole("alert")).toContainText("The product is not safe to sell only through the portal yet.");
  await expect(page.getByRole("alert")).toContainText("Shopify is not connected here");

  await row().getByRole("button", { name: /Check guard/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Guard:" })).toContainText("Not safe to open — Shopify is not connected here");
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Early access: the kind, the public release and ships note; Open asks for the public release first", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const label = `Early ${tag(info)}`;
  await page.goto("/admin#/circle/object");
  const form = page.getByRole("form", { name: "New release" });
  await expect(form.getByRole("group", { name: "Early access" })).toBeHidden();
  await form.getByLabel("Kind").selectOption("early_access");
  await expect(form.getByRole("group", { name: "Early access" })).toBeVisible();
  await form.getByLabel("Label (admin only)").fill(label);
  await form.getByLabel("Shopify product id").fill("333");
  await form.getByLabel("Shopify variant id").fill("444");
  const post = page.waitForRequest((r) => r.url().endsWith("/api/admin/member-object/releases") && r.method() === "POST");
  await form.getByRole("button", { name: "Save release" }).click();
  expect((await post).postDataJSON()).toEqual({ label, kind: "early_access", product_gid: "gid://shopify/Product/333", variant_gid: "gid://shopify/ProductVariant/444" });
  const row = () => page.getByRole("table", { name: "Releases" }).getByRole("row", { name: new RegExp(label) });
  await expect(row()).toContainText("Early access");
  await expect(row()).toContainText("Draft");

  await row().getByRole("button", { name: /^Open/ }).click();
  await expect(page.getByRole("alert")).toContainText("Set the public release time first.");
  await expect(page.getByRole("alert")).toContainText("Missing: public release");
  expect(await a11y(page)).toEqual([]);

  await row().getByRole("button", { name: /^Edit/ }).click();
  const edit = page.getByRole("form", { name: `Edit ${label}` });
  await expect(edit.getByRole("group", { name: "Early access" })).toBeVisible();
  await edit.getByLabel("Public release (UTC)").fill("2026-12-10T12:00");
  await edit.getByLabel("Ships note").fill("Ships in March");
  const patch = page.waitForRequest((r) => r.method() === "PATCH");
  await edit.getByRole("button", { name: "Save release" }).click();
  expect((await patch).postDataJSON()).toEqual({ public_release_at: "2026-12-10T12:00:00.000Z", ships_note: "Ships in March" });
  await expect(row()).toContainText("Public release Dec 10, 2026");

  // With the public release set, the window is derived; the figures are still missing.
  await row().getByRole("button", { name: /^Open/ }).click();
  await expect(page.getByRole("alert")).toContainText("Missing: price, edition size, unit cost, shipping class, reservation hours");
  await expect(page.getByRole("alert")).not.toContainText("public release");
  expect(errors).toEqual([]);
});

test("Capsules: create one, then close it", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const title = `Winter capsule ${tag(info)}`;
  await page.goto("/admin#/circle/capsules");
  await expect(page.getByRole("heading", { level: 1, name: "Capsules" })).toBeVisible();
  const form = page.getByRole("form", { name: "New capsule" });
  await form.getByLabel("Season").fill("Winter 2026");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Shopify product id").fill("987");
  await form.getByLabel("Price (credits)").fill("60");
  await form.getByLabel("Opens (UTC)").fill("2026-12-01T09:00");
  await form.getByLabel("Closes (UTC)").fill("2026-12-15T09:00");
  await form.getByRole("button", { name: "Save capsule" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Capsule saved." })).toBeVisible();
  const row = () => page.getByRole("table", { name: "Capsules" }).getByRole("row", { name: new RegExp(title) });
  await expect(row()).toContainText("Scheduled");
  await expect(row()).toContainText("60 credits");
  await expect(row()).toContainText("2 months");
  expect(await a11y(page)).toEqual([]);

  page.once("dialog", (d) => d.accept());
  await row().getByRole("button", { name: /^Close/ }).click();
  await expect(row()).toContainText("Closed");
  expect(errors).toEqual([]);
});

test("Invitations on the real Worker: an empty review queue", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  await page.goto("/admin#/circle/invitations");
  await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeVisible();
  await expect(page.getByText("Nothing is waiting for review.")).toBeVisible();
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Invitations: the review queue shows why, Credit sends the decision", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const inv = {
    id: "R1", status: "review", reason: "card matches the member's; same shipping address as the member", season: "2026Q4",
    discount_cents: 1000, reward_cents: 1000, friend_paid_invoices: 2, created_at: "2026-10-01T10:00:00Z", credited_at: null,
    member_email: "anna@example.com", friend_email: "ben@example.com",
  };
  const sent: unknown[] = [];
  await page.route("**/api/admin/invitations**", (route) => {
    const r = route.request();
    if (r.method() === "PATCH") {
      sent.push({ url: new URL(r.url()).pathname, body: r.postDataJSON(), client: r.headers()["x-sr-client"] });
      Object.assign(inv, { status: "credited", reason: null, credited_at: "2026-10-16T12:00:00Z" });
      return route.fulfill({ json: { status: "credited", reason: null } });
    }
    return route.fulfill({ json: { invitations: [inv], review: inv.status === "review" ? [inv] : [] } });
  });
  await page.goto("/admin#/circle/invitations");
  const row = page.getByRole("table", { name: "Review queue" }).getByRole("row", { name: /anna@example.com/ });
  await expect(row).toContainText("ben@example.com");
  await expect(row).toContainText("card matches the member's");
  await expect(row).toContainText("2026Q4");
  expect(await a11y(page)).toEqual([]);

  page.once("dialog", (d) => { expect(d.message()).toContain("10 credits"); d.accept(); });
  await row.getByRole("button", { name: /^Credit/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invitation credited." })).toBeVisible();
  expect(sent).toEqual([{ url: "/api/admin/invitations/R1", body: { decision: "credit" }, client: "admin" }]);
  await expect(page.getByText("Nothing is waiting for review.")).toBeVisible();
  await expect(page.getByRole("table", { name: "All invitations" })).toContainText("Credited");
  expect(errors).toEqual([]);
});
