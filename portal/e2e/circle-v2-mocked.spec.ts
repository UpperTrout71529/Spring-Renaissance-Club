// V2 Circle portal with the API mocked — the states the e2e Worker cannot
// reach (Shopify is off there, so card codes, claims and capsules answer 503):
// every member-page block, the §6.7 banners, Use credits through to the code,
// the members' object and early access, capsules and Skip, the anniversary
// address, the welcome timing, billing and the priority concierge offer.

import { expect, test, type Page, type Route } from "@playwright/test";
import { a11yViolations } from "./helpers";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const fail = (route: Route, status: number, code: string, message: string) => json(route, { error: { code, message } }, status);

const ME = (tier: "club" | "vip" = "vip") => ({
  user: { id: "01USER", email: "clara@example.com", first_name: "Clara", last_name: null, tier, created_at: "2026-10-02T09:00:00Z", seasonal_email_opt_in: false },
  membership: null, badges: { circle: false }, onboarding: { passkey: true, saved: true, dismissed: false },
});

const MEMBERSHIP = {
  status: "active", kind: "join", since: "2026-10-14T10:00:00Z", current_period_end: "2026-11-14T10:00:00Z",
  ends_on: null, end_reason: null, credits_grace_until: null, paid_months: 1,
};

function summary(over: Record<string, unknown> = {}, m: Record<string, unknown> = {}) {
  return {
    membership: { ...MEMBERSHIP, ...m }, balance_cents: 4600, next_accrual: { date: "2026-11-14", amount_cents: 2000 },
    expires_on: null, frozen: false, welcome: { status: "chosen" }, ...over,
  };
}

const RELEASE = {
  id: "rel1", title: null, description: "Hand-thrown, in an edition for members.", image_url: null, price_cents: 18000,
  closes_at: "2099-01-01T00:00:00Z", sold_out: false, one_per_member: true,
};
const NO_RELEASE = { release: null, claim: null, can_claim: false, reason: "no_release" };

async function asMember(page: Page, circle: unknown = summary(), extra: { object?: unknown; early?: unknown; capsules?: unknown } = {}) {
  await page.route("**/api/me", (r) => json(r, ME("vip")));
  await page.route("**/api/circle", (r) => json(r, circle));
  await page.route("**/api/circle/object", (r) => json(r, extra.object ?? NO_RELEASE));
  await page.route("**/api/circle/early-access", (r) => json(r, extra.early ?? NO_RELEASE));
  await page.route("**/api/circle/capsules", (r) => json(r, extra.capsules ?? { current: null, upcoming: [] }));
}

const FORBIDDEN_NAMES = /Welcome Gift|Complimentary Gift/i;

test("member page: every block when it applies; the piece is never named a gift; axe", async ({ page }) => {
  await asMember(page, summary({ welcome: { status: "awaiting_choice" }, anniversary: { status: "awaiting_address" } }), {
    object: { release: RELEASE, claim: null, can_claim: true, reason: null },
    early: { release: { ...RELEASE, id: "rel2", member_price_cents: 13500, public_release_at: null, ships_note: null }, claim: null, can_claim: true, reason: null },
    capsules: { current: null, upcoming: [{ id: "c2", season: "Winter", title: "The Winter capsule", price_cents: 6800, opens_at: "2026-12-01T00:00:00Z", closes_at: "2026-12-20T00:00:00Z", skipped: false, claimed: false, product_url: null, eligible: true, reason: null }] },
  });
  await page.goto("/circle");
  await expect(page.getByText("Member since Oct 2026")).toBeVisible();
  const treasury = page.getByRole("region", { name: "The Treasury" });
  await expect(treasury.locator(".treasury-balance")).toHaveText("46 credits");
  await expect(treasury.getByText("= $46 to spend in the house")).toBeVisible();
  await expect(treasury.getByText("+20 on Nov 14, 2026")).toBeVisible();
  await expect(page.getByRole("region", { name: "Welcome piece" }).getByRole("link", { name: "Choose your sealed piece" })).toHaveAttribute("href", "/circle/welcome");
  await expect(page.getByRole("region", { name: "Early access" })).toContainText("Pre-order before the public release.");
  await expect(page.getByRole("region", { name: "Early access" }).getByRole("link")).toHaveAttribute("href", "/circle/early-access");
  await expect(page.getByRole("region", { name: "The members' object" }).getByRole("link")).toHaveAttribute("href", "/circle/object");
  await expect(page.getByRole("region", { name: "A year in the Circle" }).getByRole("link", { name: "Confirm the address" })).toHaveAttribute("href", "/circle/anniversary");
  await expect(page.getByRole("region", { name: "Capsules" })).toContainText("Next capsule: Winter");
  await expect(page.getByRole("region", { name: "Invite a friend" }).getByRole("link")).toHaveAttribute("href", "/circle/invite");
  await expect(page.getByRole("region", { name: "Concierge" }).getByRole("link", { name: "Write to us" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your rooms" }).getByRole("link")).toHaveAttribute("href", "/circle/rooms");
  await expect(page.locator(".circle-banner")).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toMatch(FORBIDDEN_NAMES);
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByRole("region", { name: "The members' object" }).getByRole("link").click();
  await expect(page).toHaveURL(/\/circle\/object$/);
  await expect(page.getByRole("link", { name: "Circle", exact: true })).toHaveAttribute("aria-current", "page");
});

test("§6.7 banners: past_due → Update card; canceling → Keep my membership; ended → credits expire + Rejoin", async ({ page }) => {
  let circle: unknown = summary({ next_accrual: null }, { status: "past_due" });
  const calls: string[] = [];
  await asMember(page);
  await page.route("**/api/circle", (r) => json(r, circle));
  await page.route("**/api/account/membership/portal", (r) => { calls.push("portal"); return json(r, { url: "/__e2e/billing-portal" }); });
  await page.route("**/api/circle/cancel/undo", (r) => { calls.push("undo"); circle = summary(); return json(r, { status: "active" }); });

  await page.goto("/circle");
  const banner = page.locator(".circle-banner");
  await expect(banner).toContainText("We couldn't take your last payment. We'll try again; update your card to keep your member price. Credits you already have are still yours to use.");
  expect(await a11yViolations(page)).toEqual([]);
  await banner.getByRole("button", { name: "Update card" }).click();
  await expect(page).toHaveURL(/\/__e2e\/billing-portal$/);
  expect(calls).toEqual(["portal"]);

  circle = summary({ next_accrual: null }, { status: "canceling", ends_on: "2026-11-14" });
  await page.goto("/circle");
  await expect(banner).toHaveText(/^Your membership ends Nov 14, 2026\. Credits stay usable until Dec 14, 2026\.Keep my membership$/);
  await banner.getByRole("button", { name: "Keep my membership" }).click();
  await expect(banner).toHaveCount(0);
  expect(calls).toEqual(["portal", "undo"]);

  circle = summary({ next_accrual: null, expires_on: "2026-12-14" }, { status: "ended", end_reason: "payment_failed", ends_on: "2026-11-14", credits_grace_until: "2026-12-14T10:00:00Z" });
  await page.goto("/circle");
  await expect(banner).toContainText("46 credits expire on Dec 14, 2026.");
  await expect(banner).toContainText("Your membership ended because a payment couldn't be collected.");
  await expect(banner.getByRole("link", { name: "Rejoin for $20" })).toHaveAttribute("href", "/circle/join");
  await expect(banner.getByRole("link", { name: "Use credits" })).toHaveAttribute("href", "/circle/credits/use");
  // An ended member has no capsules, invitations or concierge blocks.
  await expect(page.getByRole("region", { name: "Capsules" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Invite a friend" })).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);
});

async function mockStepUp(page: Page, onVerified: () => void) {
  await page.route("**/api/passkeys", (r) => json(r, { passkeys: [] }));
  await page.route("**/api/auth/step-up/email-code", (r) => json(r, { ok: true }, 202));
  await page.route("**/api/auth/step-up/verify", (r) => { onVerified(); return r.fulfill({ status: 204 }); });
}

test("Use credits: checks the amount, step-up, a fresh key per attempt, the code once with Copy code and Shop now", async ({ page, context }, info) => {
  if (info.project.name.startsWith("chromium")) await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await asMember(page);
  let steppedUp = false;
  await mockStepUp(page, () => { steppedUp = true; });
  const calls: { key: string | null; body: unknown }[] = [];
  await page.route("**/api/credits/redeem", (r) => {
    calls.push({ key: r.request().headers()["idempotency-key"] ?? null, body: r.request().postDataJSON() });
    if (!steppedUp) return fail(r, 403, "step_up_required", "Please confirm it's you to continue.");
    if (calls.length === 2) return fail(r, 409, "insufficient_credits", "You don't have that many credits.");
    return json(r, { redemption: { id: "red1", amount_cents: 1200, code: "SRGC-7H2K-QX4M-1029", last4: "1029", status: "issued" } }, 201);
  });

  await page.goto("/circle/credits/use");
  const amount = page.getByLabel("Credits to use");
  await expect(amount).toHaveValue("46");
  await expect(page.getByText("You have 46 credits. 1 credit = $1.")).toBeVisible();
  for (const [v, msg] of [["47", "You have 46 credits."], ["0", "Use at least 1 credit."], ["2.5", "Choose a whole number of credits."]]) {
    await amount.fill(v);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toHaveText(msg);
  }
  await amount.fill("12");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Confirm" })).toBeFocused();
  await expect(page.getByText("We'll create a single-use gift card for $12. Use it at checkout — any balance left stays on the card.")).toBeVisible();
  await expect(page.locator(".steps-form strong")).toHaveText("$12");

  await page.getByRole("button", { name: "Create my card" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  await dialog.getByLabel("Confirmation code").fill("123456");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("alert")).toHaveText("You don't have that many credits.");
  await page.getByRole("button", { name: "Create my card" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Your card is ready" })).toBeVisible();
  await expect(page.locator(".code-value")).toHaveText("SRGC-7H2K-QX4M-1029");
  await expect(page.getByText("This code is shown once here. We've also emailed it to you.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Shop now" })).toHaveAttribute("href", "https://springrenaissance.store/collections/all");
  expect(calls.map((c) => c.body)).toEqual([{ amount_cents: 1200 }, { amount_cents: 1200 }, { amount_cents: 1200 }]);
  // The retry after step-up is the same attempt (same key); after a refusal, a new one.
  expect(calls[0].key).toBeTruthy();
  expect(calls[1].key).toBe(calls[0].key);
  expect(calls[2].key).not.toBe(calls[1].key);
  if (info.project.name.startsWith("chromium")) {
    await page.getByRole("button", { name: "Copy code" }).click();
    await expect(page.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("SRGC-7H2K-QX4M-1029");
  }
  expect(await a11yViolations(page)).toEqual([]);
});

test("Use credits: a repeated attempt shows no code again", async ({ page }) => {
  await asMember(page);
  await page.route("**/api/credits/redeem", (r) => json(r, { redemption: { id: "red1", amount_cents: 4600, code: null, last4: "1029", status: "issued" }, repeated: true }));
  await page.goto("/circle/credits/use");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create my card" }).click();
  await expect(page.getByText("Your card has already been created. We've emailed you the code.")).toBeVisible();
  await expect(page.locator(".code-value")).toHaveCount(0);
});

test("credits history: a table on desktop, a list on mobile; Load more; return an unused card", async ({ page }) => {
  await asMember(page);
  const rows = [
    { date: "2026-11-14T10:00:00Z", memo: "Monthly credits — November", amount_cents: 2000, kind: "accrual", running_balance_cents: 4600 },
    { date: "2026-11-02T10:00:00Z", memo: "Used at checkout · card ••7H2K", amount_cents: -1400, kind: "redemption", running_balance_cents: 2600 },
    { date: "2026-10-14T10:00:00Z", memo: "Welcome — first month", amount_cents: 2000, kind: "welcome_accrual", running_balance_cents: 4000 },
  ];
  await page.route("**/api/circle/credits**", (r) => {
    const cursor = new URL(r.request().url()).searchParams.get("cursor");
    const base = { balance_cents: 4600, next_accrual: { date: "2026-12-14", amount_cents: 2000 }, expires_on: null, frozen: false };
    return json(r, cursor ? { ...base, ledger: rows.slice(2), next_cursor: null } : { ...base, ledger: rows.slice(0, 2), next_cursor: "c2" });
  });
  let returned = false;
  await page.route("**/api/credits/redemptions", (r) => json(r, { redemptions: [
    { id: "red7", amount_cents: 1400, last4: "7H2K", status: returned ? "deactivated" : "issued", purpose: "credits", created_at: "2026-11-02T10:00:00Z" },
  ] }));
  await page.route("**/api/credits/redemptions/red7/return", (r) => { returned = true; return json(r, { returned: true, balance_cents: 6000 }); });

  await page.goto("/circle/credits");
  const mobile = (page.viewportSize()?.width ?? 0) < 768;
  const table = page.getByRole("table", { name: "Credits history" });
  const list = page.getByRole("list", { name: "Credits history" });
  if (mobile) {
    await expect(table).toBeHidden();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("listitem").nth(1)).toContainText("Used at checkout · card ••7H2K");
    await expect(list.getByRole("listitem").nth(1)).toContainText("−14");
  } else {
    await expect(list).toBeHidden();
    await expect(table.getByRole("columnheader")).toHaveText(["Date", "Description", "Credits", "Balance"]);
    await expect(table.getByRole("row").nth(2)).toHaveText(["Nov 2, 2026", "Used at checkout · card ••7H2K", "−14", "26"].join(""));
  }
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(mobile ? list.getByRole("listitem") : table.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);

  const cards = page.getByRole("region", { name: "Your cards" });
  await cards.getByRole("button", { name: "Return to credits: card ••7H2K" }).click();
  await expect(page.getByText("The card is back in your credits.")).toBeVisible();
  await expect(cards.getByText("Returned to credits")).toBeVisible();
});

test("members' object: no name until Felix sets one; Reserve mine → reserved until + Pay now; sold out, closed, paid", async ({ page }) => {
  let view: Record<string, unknown> = { release: RELEASE, claim: null, can_claim: true, reason: null };
  const claims: unknown[] = [];
  await asMember(page);
  await page.route("**/api/circle/object", (r) => json(r, view));
  await page.route("**/api/circle/object/claim", (r) => {
    claims.push(r.request().postDataJSON());
    return json(r, { status: "invoiced", invoice_url: "https://springrenaissance.store/12345/invoices/abc", reserved_until: "2026-10-18T15:00:00Z" }, 201);
  });

  await page.goto("/circle/object");
  await expect(page).toHaveTitle("The members' object · Spring Renaissance");
  await expect(page.getByRole("heading", { level: 1, name: "The members' object" })).toBeVisible();
  await expect(page.locator("main h2")).toHaveCount(0); // title null → no name
  await expect(page.getByText("Hand-thrown, in an edition for members.")).toBeVisible();
  await expect(page.locator(".object-price")).toHaveText("$180");
  await expect(page.getByText("One per member.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Reserve mine" }).click();
  await expect(page.getByText(/^Reserved for you until Oct 18, 2026, \d{1,2}:00 [AP]M\.$/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Pay now" })).toHaveAttribute("href", "https://springrenaissance.store/12345/invoices/abc");
  expect(claims).toEqual([{ release_id: "rel1" }]);

  view = { release: { ...RELEASE, sold_out: true }, claim: null, can_claim: false, reason: "sold_out" };
  await page.reload();
  await expect(page.getByText("All pieces in this edition have found homes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reserve mine" })).toHaveCount(0);

  view = { release: { ...RELEASE, closes_at: "2026-01-01T00:00:00Z" }, claim: null, can_claim: true, reason: null };
  await page.reload();
  await expect(page.getByText("This release has closed.")).toBeVisible();

  view = { release: { ...RELEASE, title: "Le Vase Livre" }, claim: { status: "paid", reserved_until: null, invoice_url: null }, can_claim: false, reason: "already_claimed" };
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Le Vase Livre" })).toBeVisible();
  await expect(page.getByText("Yours. Thank you.")).toBeVisible();

  view = { release: null, claim: null, can_claim: false, reason: "no_release" };
  await page.reload();
  await expect(page.getByRole("heading", { name: "No members' object right now" })).toBeVisible();
});

test("members' object: Shopify unreachable → a calm retry; a claim still being prepared says so", async ({ page }) => {
  await asMember(page, summary(), { object: { release: RELEASE, claim: null, can_claim: true, reason: null } });
  let n = 0;
  await page.route("**/api/circle/object/claim", (r) => (++n === 1
    ? fail(r, 503, "object_unavailable", "We couldn't reserve the piece just now. Please try again in a moment.")
    : json(r, { status: "creating", invoice_url: null, reserved_until: null })));
  await page.goto("/circle/object");
  await page.getByRole("button", { name: "Reserve mine" }).click();
  await expect(page.getByRole("alert")).toHaveText("We couldn't reserve the piece just now. Please try again in a moment.");
  await page.getByRole("button", { name: "Reserve mine" }).click();
  await expect(page.locator(".object-state")).toHaveText("We're preparing your reservation. Please check back in a few minutes.");
  await expect(page.getByRole("link", { name: "Pay now" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("members' object: a refused claim shows the edition's state", async ({ page }) => {
  await asMember(page, summary(), { object: { release: RELEASE, claim: null, can_claim: true, reason: null } });
  await page.route("**/api/circle/object/claim", (r) => fail(r, 409, "sold_out", "All pieces in this edition have found homes."));
  await page.goto("/circle/object");
  await page.getByRole("button", { name: "Reserve mine" }).click();
  await expect(page.locator(".object-state")).toHaveText("All pieces in this edition have found homes.");
});

test("early access: pre-order before the public release at the member price; the ship note only when present", async ({ page }) => {
  let early: Record<string, unknown> = {
    release: { ...RELEASE, id: "ea1", title: "The Kouros Fragment", price_cents: 22000, member_price_cents: 16500,
      public_release_at: "2026-11-01T15:00:00Z", ships_note: "Ships in the first week of December." },
    claim: null, can_claim: true, reason: null,
  };
  const claims: unknown[] = [];
  await asMember(page);
  await page.route("**/api/circle/early-access", (r) => json(r, early));
  await page.route("**/api/circle/early-access/claim", (r) => {
    claims.push(r.request().postDataJSON());
    return json(r, { status: "invoiced", invoice_url: "https://springrenaissance.store/12345/invoices/ea", reserved_until: "2026-10-18T15:00:00Z" }, 201);
  });
  await page.goto("/circle/early-access");
  await expect(page).toHaveTitle("Early access · Spring Renaissance");
  await expect(page.getByRole("heading", { level: 1, name: "Early access" })).toBeVisible();
  await expect(page.getByText("Pre-order before the public release.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "The Kouros Fragment" })).toBeVisible();
  await expect(page.locator(".object-price")).toHaveText("$165");
  await expect(page.getByText("Regular price $220")).toBeVisible();
  await expect(page.getByText("Public release Nov 1, 2026.")).toBeVisible();
  await expect(page.getByText("Ships in the first week of December.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Reserve mine" }).click();
  await expect(page.getByText(/^Reserved for you until Oct 18, 2026/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Pay now" })).toHaveAttribute("href", "https://springrenaissance.store/12345/invoices/ea");
  expect(claims).toEqual([{ release_id: "ea1" }]);

  early = { ...early, release: { ...(early.release as object), ships_note: null, public_release_at: null } };
  await page.reload();
  await expect(page.getByText("Ships in the first week of December.")).toHaveCount(0);
  await expect(page.getByText(/^Public release/)).toHaveCount(0);
});

test("capsules: claim shows the code once; Skip asks in §16.2 words and can be undone before the window", async ({ page }) => {
  const capsules = {
    current: { id: "c1", season: "Autumn", title: "The Autumn capsule", price_cents: 6800, opens_at: "2026-10-01T00:00:00Z", closes_at: "2026-10-31T00:00:00Z",
      skipped: false, claimed: false, product_url: "https://springrenaissance.store/products/autumn-capsule", eligible: true, reason: null },
    upcoming: [{ id: "c2", season: "Winter", title: "The Winter capsule", price_cents: 7200, opens_at: "2026-12-01T00:00:00Z", closes_at: "2026-12-31T00:00:00Z",
      skipped: false, claimed: false, product_url: null, eligible: true, reason: null }],
  };
  const calls: string[] = [];
  await asMember(page, summary(), { capsules });
  let steppedUp = false;
  await mockStepUp(page, () => { steppedUp = true; });
  await page.route("**/api/circle/capsules/c1/claim", (r) => {
    calls.push("claim");
    if (!steppedUp) return fail(r, 403, "step_up_required", "Please confirm it's you to continue.");
    return json(r, { capsule_id: "c1", amount_cents: 4600, code: "CAPS-AUTU-MN46", last4: "MN46", product_url: capsules.current.product_url }, 201);
  });
  await page.route("**/api/circle/skips", (r) => { calls.push(`skip ${JSON.stringify(r.request().postDataJSON())}`); return json(r, { skipped: true }, 201); });
  await page.route("**/api/circle/skips/c2", (r) => { calls.push(`undo ${r.request().method()}`); return json(r, { skipped: false }); });

  await page.goto("/circle/capsules");
  await expect(page.getByRole("heading", { level: 1, name: "Capsules" })).toBeVisible();
  const current = page.getByRole("article", { name: "The Autumn capsule" });
  await expect(current).toContainText("$68 in credits or at checkout");
  expect(await a11yViolations(page)).toEqual([]);
  await current.getByRole("button", { name: "Claim with credits" }).click();
  // A fresh step-up first (§10.4), then the same claim again.
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  await dialog.getByLabel("Confirmation code").fill("123456");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(current).toContainText("A single-use gift card for $46. Use it at checkout for this capsule.");
  await expect(current.locator(".code-value")).toHaveText("CAPS-AUTU-MN46");
  await expect(current.getByRole("link", { name: "View the capsule" })).toHaveAttribute("href", "https://springrenaissance.store/products/autumn-capsule");

  const winter = page.getByRole("article", { name: "The Winter capsule" });
  await expect(winter).toContainText("Opens Dec 1, 2026");
  await winter.getByRole("button", { name: "Skip Winter capsule" }).click();
  await expect(winter.getByText("Skip the Winter capsule? Your membership and credits continue as usual — you'll still receive 20 credits on Nov 14, 2026. We won't reserve this season's capsule for you.")).toBeVisible();
  await expect(winter.getByRole("button", { name: "Don't skip" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await winter.getByRole("button", { name: "Skip Winter capsule" }).click();
  await expect(winter.getByText("Skipped. Your membership and credits continue as usual.")).toBeVisible();
  await winter.getByRole("button", { name: "Undo skip" }).click();
  await expect(winter.getByRole("button", { name: "Skip Winter capsule" })).toBeVisible();
  expect(calls).toEqual(["claim", "claim", 'skip {"capsule_id":"c2"}', "undo DELETE"]);
});

test("anniversary: the address is prefilled, checked like the server, and sent", async ({ page }) => {
  const posts: unknown[] = [];
  await asMember(page);
  await page.route("**/api/circle/anniversary", (r) => {
    if (r.request().method() === "POST") { posts.push(r.request().postDataJSON()); return json(r, { status: "ready" }); }
    return json(r, { gift: { id: "g1", n: 1, status: "awaiting_address", name: "Clara Duval",
      address: { line1: "1 Main St", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US" } } });
  });
  await page.goto("/circle/anniversary");
  await expect(page.getByRole("heading", { level: 1, name: "A year in the Circle" })).toBeVisible();
  await expect(page.getByText("To mark your anniversary, we'd like to send you something. Please confirm where it should go.")).toBeVisible();
  await expect(page.getByLabel("Full name")).toHaveValue("Clara Duval");
  await expect(page.getByLabel("Address", { exact: true })).toHaveValue("1 Main St");
  await expect(page.getByLabel("State")).toHaveValue("TX");
  await page.getByLabel("ZIP code").fill("787");
  await page.getByRole("button", { name: "Send my gift" }).click();
  await expect(page.getByText("Enter a 5-digit ZIP code.")).toBeVisible();
  await expect(page.getByLabel("ZIP code")).toBeFocused();
  expect(posts).toEqual([]);
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByLabel("ZIP code").fill("78702");
  await page.getByLabel("Apartment, suite (optional)").fill("Apt 4");
  await page.getByRole("button", { name: "Send my gift" }).click();
  await expect(page.getByText("Thank you. We'll send it to this address.")).toBeVisible();
  expect(posts).toEqual([{ address: { name: "Clara Duval", line1: "1 Main St", line2: "Apt 4", city: "Austin", state: "TX", postal_code: "78702", country: "US" } }]);
  await expect(page.locator(".address-view")).toContainText("Austin, TX 78702");
});

test("welcome: past 20 s the page says it is taking longer than usual", async ({ page }) => {
  let polls = 0;
  await page.route("**/api/me", (r) => json(r, ME("club")));
  await page.route("**/api/circle", (r) => { polls++; return json(r, { membership: null }); });
  await page.clock.install();
  await page.goto("/circle/welcome?session_id=cs_test_1");
  await expect(page.getByText("Confirming your membership…").first()).toBeVisible();
  const slow = page.getByText("This is taking longer than usual — we'll email you as soon as it's confirmed.");
  await expect.poll(async () => {
    await page.clock.runFor(2000);
    return slow.isVisible();
  }, { timeout: 20_000 }).toBe(true);
  // At most one check per 2 s for 20 s (the fake clock may jump past a check
  // while one is in flight, so fewer is fine), then it stops asking.
  expect(polls).toBeGreaterThanOrEqual(2);
  expect(polls).toBeLessThanOrEqual(11);
  const settled = polls;
  await page.clock.runFor(10_000);
  expect(polls).toBe(settled);
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
});

const WELCOME = { status: "awaiting_choice", options: [
  { id: "gw1", title: "The bell", blurb: "Rings once, softly.", image_url: null },
  { id: "gw2", title: "The dish", blurb: "For keys, or nothing.", image_url: null },
] };

test("welcome: the unsealing can be skipped with a tap", async ({ page }) => {
  await asMember(page, summary({ welcome: { status: "awaiting_choice" } }));
  await page.route("**/api/circle/welcome", (r) => json(r, WELCOME));
  await page.goto("/circle/welcome");
  await expect(page.getByRole("button", { name: "Your sealed piece" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Choose your sealed piece" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.getByText("One of these will be yours. Choose the piece you would like us to send.")).toBeVisible();
});

test("welcome: with reduced motion there is no unsealing animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await asMember(page, summary({ welcome: { status: "awaiting_choice" } }));
  await page.route("**/api/circle/welcome", (r) => json(r, WELCOME));
  await page.goto("/circle/welcome");
  await expect(page.getByRole("heading", { level: 1, name: "Choose your sealed piece" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Your sealed piece" })).toHaveCount(0);
});

test("welcome: a rejoin has no new piece — welcome back", async ({ page }) => {
  await asMember(page, summary({ welcome: null }, { kind: "rejoin" }));
  await page.route("**/api/circle/welcome", (r) => json(r, { status: null, options: [] }));
  await page.goto("/circle/welcome");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back to the Circle" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to the Circle" })).toHaveAttribute("href", "/circle");
});

test("membership & billing: past_due — Update card, I've updated my card; invoices with receipts", async ({ page }) => {
  await asMember(page);
  await page.route("**/api/account/membership", (r) => json(r, {
    status: "past_due", kind: "join", since: "2026-10-14T10:00:00Z", monthly_cents: 2000, current_period_end: "2026-11-14",
    ends_on: null, credits_grace_until: null, next_charge: null,
    invoices: [
      { date: "2026-11-14", amount_paid_cents: 0, status: "open", url: "https://invoice.stripe.com/i/2" },
      { date: "2026-10-14", amount_paid_cents: 5000, status: "paid", url: "https://invoice.stripe.com/i/1" },
    ],
  }));
  await page.route("**/api/circle/billing/retry", (r) => json(r, { result: "paid" }));
  await page.goto("/account/membership");
  await expect(page.getByRole("heading", { level: 1, name: "Membership & billing" })).toBeVisible();
  await expect(page.locator(".circle-banner")).toContainText("We couldn't take your last payment.");
  await expect(page.getByRole("link", { name: "Receipt for Oct 14, 2026" })).toHaveAttribute("href", "https://invoice.stripe.com/i/1");
  await expect(page.locator(".invoice-list li").first()).toContainText("$0 · Open");
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "I've updated my card" }).click();
  await expect(page.getByRole("status")).toHaveText("Thank you — your payment went through.");
});

test("cancel: 'an order didn't go well' offers the concierge as a priority, and keeping the membership records it", async ({ page }) => {
  await asMember(page);
  await page.route("**/api/account/membership", (r) => json(r, {
    status: "active", kind: "join", since: "2026-10-14T10:00:00Z", monthly_cents: 2000, current_period_end: "2026-11-14",
    ends_on: null, credits_grace_until: null, next_charge: { date: "2026-11-14", amount_cents: 2165 }, invoices: [],
  }));
  const posts: Record<string, unknown> = {};
  await page.route("**/api/circle/cancel/start", (r) => {
    posts.start = r.request().postDataJSON();
    return json(r, { cancellation_id: "can1", offer: { kind: "concierge_priority", copy: "We'd like to make this right." }, ends_on: "2026-11-14", credits_until: "2026-12-14", balance_cents: 4600 }, 201);
  });
  await page.route("**/api/circle/cancel/keep", (r) => { posts.keep = r.request().postDataJSON(); return json(r, { kept: true }); });
  await page.route("**/api/circle/concierge", (r) => {
    if (r.request().method() === "POST") { posts.concierge = r.request().postDataJSON(); return json(r, { sent: true }, 201); }
    return json(r, { messages: [], unread: 0 });
  });

  await page.goto("/account/membership");
  await expect(page.locator(".facts")).toContainText("Next charge$21.65 on Nov 14, 2026");
  await page.getByRole("button", { name: "Cancel membership" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toHaveText("Please choose a reason.");
  await page.getByRole("radio", { name: "An order or delivery didn't go well" }).check();
  await page.getByLabel("Tell us more (optional)").fill("The vase arrived chipped.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".cancel-offer")).toContainText("We'd like to make this right.");
  await expect(page.locator(".cancel-facts")).toHaveText("If you cancel: your membership ends on Nov 14, 2026 (no further charges). Your 46 credits stay usable until Dec 14, 2026, then expire. Your member price ends on Nov 14, 2026.");
  await expect(page.getByRole("button", { name: "Cancel membership" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep my membership" })).toBeVisible();
  await page.getByRole("button", { name: "Write to the concierge" }).click();
  await expect(page).toHaveURL(/\/circle\/concierge\?priority=1$/);
  expect(posts.start).toEqual({ reason: "order_issue", comment: "The vase arrived chipped." });
  expect(posts.keep).toEqual({ cancellation_id: "can1", offer_accepted: true });
  await expect(page.getByText("We'll make this a priority.")).toBeVisible();
  await page.getByRole("textbox", { name: "Your message" }).fill("The vase arrived chipped. Could you help?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => posts.concierge).toEqual({ body: "The vase arrived chipped. Could you help?", priority: true });
});

test("join (mocked): closed calmly; an invitation lowers the joining fee; rejoin has none; changed terms reload", async ({ page }) => {
  const base = {
    terms_version: "t1", terms_url: "https://x/terms/membership", region_note: "The Circle is currently available in the United States.",
    consents: [{ id: "terms", text: "I agree to the Membership Terms and to automatic monthly renewal." }, { id: "age_18", text: "I am 18 or older." }],
    invitation_note: null,
  };
  let offer: Record<string, unknown> = { ...base, kind: "join", open: false, reason: "not_open" };
  let gets = 0;
  const posts: { path: string; body: unknown }[] = [];
  await page.route("**/api/me", (r) => json(r, ME("club")));
  await page.route("**/api/circle/join**", (r) => { gets++; return json(r, offer); });
  let refuseOnce = false;
  for (const path of ["checkout", "rejoin"]) {
    await page.route(`**/api/circle/${path}`, (r) => {
      posts.push({ path, body: r.request().postDataJSON() });
      if (refuseOnce) { refuseOnce = false; return fail(r, 409, "terms_changed", "The Membership Terms have changed. Please review them again."); }
      return json(r, { url: "/__e2e/billing-portal" }, 201);
    });
  }

  await page.goto("/circle/join");
  await expect(page.getByRole("heading", { level: 1, name: "The Circle isn't open for joining yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);

  offer = { ...base, kind: "join", open: true, reason: null, first_charge_cents: 4000, monthly_cents: 2000, joining_cents: 3000, discount_cents: 1000,
    first_renewal_on: "2026-11-16", invitation_note: "Your invitation takes $10 off the joining fee.",
    disclosure: "By joining, you agree to the Membership Terms. You'll be charged $40 today, then $20 plus applicable tax every month starting November 16, 2026, until you cancel. Cancel anytime online in your account — it takes effect at the end of your paid month." };
  await page.goto("/circle/join?invite=FRIEND10");
  await expect(page.getByText("Your invitation takes $10 off the joining fee.")).toBeVisible();
  await expect(page.locator(".join-summary")).toContainText("Invitation−$10");
  await expect(page.locator(".join-summary")).toContainText("Due today$40");
  await expect(page.getByText("Then $20 a month from Nov 16, 2026, plus applicable tax, until you cancel.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the Membership Terms" })).toHaveAttribute("href", "/terms/membership");
  expect(await a11yViolations(page)).toEqual([]);

  // The terms changed meanwhile: the offer reloads with the boxes unticked.
  refuseOnce = true;
  await page.getByLabel("I agree to the Membership Terms and to automatic monthly renewal.").check();
  await page.getByLabel("I am 18 or older.").check();
  const before = gets;
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByRole("alert")).toHaveText("The Membership Terms have changed. Please review them again.");
  expect(gets).toBe(before + 1);
  await expect(page.getByLabel("I am 18 or older.")).not.toBeChecked();
  await page.getByLabel("I agree to the Membership Terms and to automatic monthly renewal.").check();
  await page.getByLabel("I am 18 or older.").check();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/__e2e\/billing-portal$/);
  expect(posts.map((p) => p.path)).toEqual(["checkout", "checkout"]);
  expect(posts[1].body).toEqual({ consents: { terms: true, age_18: true }, terms_version: "t1", invite_code: "FRIEND10" });

  offer = { ...base, kind: "rejoin", open: true, reason: null, first_charge_cents: 2000, monthly_cents: 2000, joining_cents: 0, discount_cents: 0,
    first_renewal_on: "2026-11-16", disclosure: "You'll be charged $20 today, then $20 plus applicable tax every month starting November 16, 2026, until you cancel." };
  await page.goto("/circle/join");
  await expect(page.getByRole("heading", { level: 1, name: "Rejoin the Circle" })).toBeVisible();
  await expect(page.locator(".join-summary")).not.toContainText("Joining fee");
  await expect(page.getByText("No joining fee. Rejoining does not include a new welcome piece.")).toBeVisible();
  await page.getByLabel("I agree to the Membership Terms and to automatic monthly renewal.").check();
  await page.getByLabel("I am 18 or older.").check();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/__e2e\/billing-portal$/);
  expect(posts.at(-1)).toEqual({ path: "rejoin", body: { consents: { terms: true, age_18: true }, terms_version: "t1" } });
});

test("rooms (mocked R2): the photo appears, and deleting asks first", async ({ page }) => {
  let photos = [{ id: "ph1", room_label: "Study", note: null, created_at: "2026-10-16T10:00:00Z" }];
  const calls: string[] = [];
  await asMember(page);
  await page.route("**/api/circle/rooms**", (r) => {
    const req = r.request();
    if (req.method() === "PUT") {
      calls.push(`PUT ${new URL(req.url()).searchParams.get("label")} ${req.headers()["content-type"]}`);
      photos = [{ id: "ph2", room_label: "Dining room", note: null, created_at: "2026-10-16T11:00:00Z" }, ...photos];
      return json(r, { photo: { id: "ph2", room_label: "Dining room" } }, 201);
    }
    if (req.method() === "DELETE") {
      calls.push(`DELETE ${new URL(req.url()).pathname}`);
      photos = photos.filter((p) => !req.url().endsWith(p.id));
      return json(r, { deleted: true });
    }
    if (req.url().includes("/image")) return r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64") });
    return json(r, { photos });
  });
  await page.goto("/circle/rooms");
  await expect(page.getByRole("img", { name: "Photo of Study" })).toBeVisible();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
  await page.getByLabel("Room").fill("Dining room");
  await page.getByLabel("Photo", { exact: true }).setInputFiles({ name: "room.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Add photo" }).click();
  await expect(page.getByRole("img", { name: "Photo of Dining room" })).toBeVisible();
  expect(calls).toEqual(["PUT Dining room image/jpeg"]);
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Delete photo of Study" }).click();
  await expect(page.getByRole("group", { name: "Delete this photo?" })).toBeVisible();
  await page.getByRole("group", { name: "Delete this photo?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("img", { name: "Photo of Study" })).toHaveCount(0);
  expect(calls[1]).toBe("DELETE /api/circle/rooms/ph1");
});

test("Account shows Membership & billing to members only", async ({ page }) => {
  await page.route("**/api/me", (r) => json(r, ME("vip")));
  await page.goto("/account");
  await expect(page.getByRole("link", { name: "Membership & billing" })).toHaveAttribute("href", "/account/membership");
  await page.unrouteAll();
  await page.route("**/api/me", (r) => json(r, ME("club")));
  await page.reload();
  await expect(page.getByLabel("First name")).toHaveValue("Clara");
  await expect(page.getByRole("link", { name: "Membership & billing" })).toHaveCount(0);
});
