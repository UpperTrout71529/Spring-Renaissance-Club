// T18 (V2 admin): the Renaissance Circle overview, member detail (membership,
// credits, invoices, adjust credits), flags and the concierge — against the
// real Worker behind the fake Access. Members are made through the API (magic
// link + /__e2e/seed-member); axe on every screen at both widths.

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

// Console errors other than the browser's own notes about non-2xx answers
// (some tests expect 4xx/5xx) and WebKit's <select> style quirk (admin.spec).
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

const uniqueEmail = (info: TestInfo, tag: string) =>
  `${tag}-${info.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

// A signed-in member (own cookie jar) with `months` paid invoices.
async function makeMember(info: TestInfo, email: string, months = 1) {
  const baseURL = String(info.project.use.baseURL);
  const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { Origin: baseURL, "X-SR-Client": "portal" } });
  expect((await ctx.post("/api/auth/magic-link", { data: { email, turnstile_token: "e2e-token" } })).status()).toBe(202);
  const { link } = await (await ctx.get(`/__e2e/last-link?email=${encodeURIComponent(email)}`)).json();
  const verify = await ctx.post("/api/auth/verify", { data: { token: new URL(link).hash.replace(/^#t=/, "") } });
  expect(verify.status()).toBe(200);
  const { user } = await verify.json();
  let subscription: string | null = null;
  if (months > 0) {
    const seeded = await ctx.get(`/__e2e/seed-member?email=${encodeURIComponent(email)}&months=${months}`);
    expect(seeded.status()).toBe(200);
    subscription = (await seeded.json()).subscription;
  }
  return { ctx, id: user.id as string, subscription };
}

const circleNav = (page: Page) => page.getByRole("navigation", { name: "Circle" });

test("Circle overview: members by status, money, queues; the status link filters Members", async ({ page, request }, info) => {
  const email = uniqueEmail(info, "circle-overview");
  await makeMember(info, email);
  await asAdmin(page, request);
  const errors = watchErrors(page, info);

  await page.goto("/admin");
  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Circle" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Renaissance Circle" })).toBeVisible();
  await expect(circleNav(page).getByRole("link", { name: "Circle overview" })).toHaveAttribute("aria-current", "page");
  const byStatus = page.getByRole("table", { name: "Members by status" });
  await expect(byStatus).toContainText("Active");
  await expect(page.locator(".card").filter({ hasText: "Credits outstanding" })).toContainText("$");
  await expect(page.locator(".card").filter({ hasText: "Monthly recurring" })).toContainText("$");
  for (const label of ["Open flags", "Welcome queue", "Invitations to review"]) {
    await expect(page.locator(".card").filter({ hasText: label })).toBeVisible();
  }
  expect(await a11y(page)).toEqual([]);

  await byStatus.getByRole("row", { name: /Active/ }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByLabel("Membership")).toHaveValue("active");
  await page.getByLabel("Email or name").fill(email);
  await page.getByRole("button", { name: "Search" }).click();
  const row = page.getByRole("row", { name: new RegExp(email) });
  await expect(row).toContainText("Active");
  await expect(row).toContainText(/\$\d+\.\d\d/);
  expect(errors).toEqual([]);
});

test("Member detail: membership, credits and invoices; adjust credits needs a note", async ({ page, request }, info) => {
  const email = uniqueEmail(info, "circle-credits");
  const { id } = await makeMember(info, email);
  await asAdmin(page, request);
  const errors = watchErrors(page, info);

  await page.goto(`/admin#/members/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: email })).toBeVisible();
  const membership = page.getByRole("region", { name: "Membership" });
  await expect(membership).toContainText("Active");
  await expect(membership).toContainText("Paid invoices");
  await expect(page.getByRole("table", { name: "Credit ledger" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Invoices" })).toContainText("Paid");
  const balance = page.getByTestId("credit-balance");
  const before = Number((await balance.textContent())!.replace(/[^0-9.]/g, ""));
  expect(await a11y(page)).toEqual([]);

  const keys: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/admin/credits/adjust")) keys.push(r.headers()["idempotency-key"]); });
  const form = page.getByRole("form", { name: "Adjust credits" });
  await form.getByLabel("Credits (+ or −)").fill("5");
  await form.getByLabel("Note (required)").fill("   ");
  await form.getByRole("button", { name: "Adjust credits" }).click();
  await expect(form.getByRole("alert")).toContainText("A note is required for every adjustment.");
  expect(await a11y(page)).toEqual([]);

  // The first try never reaches the server; the retry (same values) carries
  // the same Idempotency-Key, so the adjustment is booked exactly once.
  let aborted = false;
  await page.route("**/api/admin/credits/adjust", (route) => {
    if (!aborted && route.request().postDataJSON().memo === "e2e goodwill") { aborted = true; return route.abort("failed"); }
    return route.continue();
  });
  await form.getByLabel("Note (required)").fill("e2e goodwill");
  await form.getByRole("button", { name: "Adjust credits" }).click();
  await expect(form.getByRole("alert")).toContainText("Could not reach the server.");
  await form.getByRole("button", { name: "Adjust credits" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Credits adjusted." })).toBeVisible();
  await expect(page.getByRole("table", { name: "Credit ledger" })).toContainText("Adjustment by the Maison — e2e goodwill");
  await expect(page.getByTestId("credit-balance")).toContainText(`$${(before + 5).toFixed(2)}`);
  expect(keys).toHaveLength(3);
  for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
  expect(keys[1]).not.toBe(keys[0]); // the note changed: a new adjustment
  expect(keys[2]).toBe(keys[1]); // the retry: the same one
  await expect(page.getByRole("table", { name: "Credit ledger" }).getByText("Adjustment by the Maison — e2e goodwill")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("A lost dispute: flagged, credits frozen; Lift credit freeze needs a note", async ({ page, request }, info) => {
  const email = uniqueEmail(info, "circle-dispute");
  const { id, subscription } = await makeMember(info, email);
  const dispute = { id: `dp_e2e_${info.project.name}_${Date.now()}`, object: "dispute", charge: `ch_in_${subscription}_1`, payment_intent: `pi_in_${subscription}_1`, amount: 5000 };
  const event = (type: string, status: string) => ({ id: `evt_${type}_${dispute.id}`, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { ...dispute, status } } });
  expect((await request.post("/__e2e/stripe-event", { data: event("charge.dispute.created", "needs_response") })).status()).toBe(200);
  expect((await request.post("/__e2e/stripe-event", { data: event("charge.dispute.closed", "lost") })).status()).toBe(200);
  await asAdmin(page, request);
  const errors = watchErrors(page, info);

  await page.goto("/admin#/circle/flags");
  await expect(page.getByRole("table", { name: "Open flags" }).getByRole("row", { name: new RegExp(email) })).toContainText("Dispute lost");

  await page.goto(`/admin#/members/${id}`);
  const membership = page.getByRole("region", { name: "Membership" });
  await expect(membership.getByRole("definition").filter({ hasText: /^Yes$/ })).toHaveCount(1); // Credits frozen: Yes
  const form = page.getByRole("form", { name: "Lift credit freeze" });
  await form.getByRole("button", { name: "Lift credit freeze" }).click();
  await expect(form.getByRole("alert")).toContainText("A note is required.");
  expect(await a11y(page)).toEqual([]);
  await form.getByLabel("Note (required)").fill("Spoke with the member; the bank error is settled.");
  await form.getByRole("button", { name: "Lift credit freeze" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Credit freeze lifted." })).toBeVisible();
  await expect(page.getByRole("form", { name: "Lift credit freeze" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Membership" })).not.toContainText("Lift credit freeze");
  expect(errors).toEqual([]);
});

test("Flags: a duplicate subscription shows up, Resolve moves it to Resolved", async ({ page, request }, info) => {
  const email = uniqueEmail(info, "circle-flag");
  const { ctx } = await makeMember(info, email);
  expect((await ctx.get(`/__e2e/seed-member?email=${encodeURIComponent(email)}&months=1`)).status()).toBe(200);
  await asAdmin(page, request);
  const errors = watchErrors(page, info);

  await page.goto("/admin#/circle/flags");
  await expect(page.getByRole("heading", { level: 1, name: "Flags" })).toBeVisible();
  const row = page.getByRole("table", { name: "Open flags" }).getByRole("row", { name: new RegExp(email) });
  await expect(row).toContainText("Two subscriptions");
  expect(await a11y(page)).toEqual([]);
  await row.getByRole("button", { name: /Resolve/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Flag resolved." })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(email) })).toHaveCount(0);

  await page.getByRole("link", { name: "Resolved" }).click();
  const done = page.getByRole("table", { name: "Resolved flags" }).getByRole("row", { name: new RegExp(email) });
  await expect(done).toContainText("felix@example.com");
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Concierge: priority thread from a member, the admin replies (people, not AI)", async ({ page, request }, info) => {
  const email = uniqueEmail(info, "circle-concierge");
  const { ctx } = await makeMember(info, email);
  expect((await ctx.post("/api/circle/concierge", { data: { body: "My order arrived chipped.\nCan you help?", priority: true } })).status()).toBe(201);
  await asAdmin(page, request);
  const errors = watchErrors(page, info);

  await page.goto("/admin#/circle/concierge");
  await expect(page.getByRole("heading", { level: 1, name: "Concierge" })).toBeVisible();
  const row = page.getByRole("table", { name: "Conversations" }).getByRole("row", { name: new RegExp(email) });
  await expect(row).toContainText("Priority");
  await expect(row).toContainText("1");
  expect(await a11y(page)).toEqual([]);

  await row.getByRole("link", { name: email }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Conversation with ${email}` })).toBeVisible();
  await expect(page.getByRole("list", { name: "Messages" })).toContainText("My order arrived chipped.");
  await expect(page.getByText("No room photos.")).toBeVisible();
  expect(await a11y(page)).toEqual([]);

  await page.getByLabel("Your reply").fill("We are sorry — a replacement is on its way.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByRole("list", { name: "Messages" })).toContainText("We are sorry — a replacement is on its way.");
  await expect(page.getByRole("list", { name: "Messages" })).toContainText("The Maison");
  const member = await (await ctx.get("/api/circle/concierge")).json();
  expect(member.messages.at(-1)).toMatchObject({ author: "maison", body: "We are sorry — a replacement is on its way." });
  expect(errors).toEqual([]);
});

test("Concierge room photos are shown from the admin image endpoint", async ({ page, request }, info) => {
  await asAdmin(page, request);
  const errors = watchErrors(page, info);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await page.route("**/api/admin/concierge/T1", (r) => r.fulfill({ json: {
    thread: { id: "T1", status: "open", priority: 0, email: "photo@example.com" },
    messages: [{ id: "M1", author: "member", author_email: null, body: "Here is my room.", created_at: "2026-10-16T10:00:00Z", read_at: null }],
    photos: [{ id: "P1", room_label: "Living room", note: "North light", created_at: "2026-10-16T09:00:00Z" }],
  } }));
  await page.route("**/api/admin/rooms/P1/image", (r) => r.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.goto("/admin#/circle/concierge/T1");
  const img = page.getByRole("img", { name: "Room photo: Living room" });
  await expect(img).toHaveAttribute("src", "/api/admin/rooms/P1/image");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
  await expect(page.getByText("North light")).toBeVisible();
  expect(await a11y(page)).toEqual([]);
  expect(errors).toEqual([]);
});
