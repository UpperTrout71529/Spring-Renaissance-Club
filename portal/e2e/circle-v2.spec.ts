// V2 Circle portal against the real Worker (fake Stripe, Shopify off): the
// Club page with the open join gate, joining through Checkout to the welcome
// piece, the member page, credits with step-up (Shopify off → the calm 503),
// the cancel flow (≤ 3 screens) with Undo, the invitation, the concierge, room
// photos without R2 (EXIF removed before upload), the public Terms draft.

import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { a11yViolations, lastStepUpCode, mockSignedOut, signInByLink } from "./helpers";

const uniqueEmail = (info: TestInfo, tag: string) =>
  `${tag}-${info.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

async function signedInMember(page: Page, request: APIRequestContext, info: TestInfo, tag: string, months = 1) {
  const email = uniqueEmail(info, tag);
  await signInByLink(page, request, email);
  const res = await request.get(`/__e2e/seed-member?email=${encodeURIComponent(email)}&months=${months}`);
  expect(res.ok()).toBe(true);
  return email;
}

const FORBIDDEN_NAMES = /Welcome Gift|Complimentary Gift/i;

test("Club: the join gate is open — Join the Circle, the benefits that work, the Terms link", async ({ page, request }, info) => {
  await request.get("/__e2e/seed-circle");
  await signInByLink(page, request, uniqueEmail(info, "club"));
  await page.goto("/circle?checkout=canceled");
  await expect(page.getByRole("heading", { level: 1, name: "A sealed object, chosen by you." })).toBeVisible();
  await expect(page.getByText("Your payment didn't go through. Nothing was charged.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Join the Circle" })).toHaveAttribute("href", "/circle/join");
  await expect(page.getByRole("button", { name: "Reserve a place" })).toHaveCount(0);

  const benefits = page.locator(".benefits li");
  await expect(benefits).toHaveCount(11);
  await expect(benefits.filter({ hasText: "Early access" })).toHaveText("Early access — pre-order new pieces before their public release.");
  await expect(benefits.filter({ hasText: "Refills" })).toHaveText("Refills — coming.");
  await expect(benefits.filter({ hasText: "The members' object" })).toHaveText("The members' object — once a year, a piece offered only to members.");
  await expect(page.getByText("$50 to join, which includes your first month. Then $20 a month until you cancel. Cancel online at any time.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Membership Terms" })).toHaveAttribute("href", "/terms/membership");
  expect(await page.locator("main").innerText()).not.toMatch(FORBIDDEN_NAMES);
  expect(await a11yViolations(page)).toEqual([]);
});

test("join: disclosure verbatim, consents unticked, Checkout, confirming, the sealed piece, first credits", async ({ page, request }, info) => {
  await request.get("/__e2e/seed-circle");
  await signInByLink(page, request, uniqueEmail(info, "join"));
  await page.goto("/circle");
  await page.getByRole("link", { name: "Join the Circle" }).click();
  await expect(page).toHaveURL(/\/circle\/join$/);
  await expect(page).toHaveTitle("Join the Circle · Spring Renaissance");
  await expect(page.getByRole("heading", { level: 1, name: "Join the Circle" })).toBeVisible();

  const summary = page.locator(".join-summary");
  await expect(summary).toContainText("First month$20");
  await expect(summary).toContainText("Joining fee — includes your welcome piece$30");
  await expect(summary).toContainText("Due today$50");
  await expect(page.locator(".disclosure")).toHaveText(/^By joining, you agree to the Membership Terms\. You'll be charged \$50 today, then \$20 plus applicable tax every month starting \w+ \d{1,2}, \d{4}, until you cancel\. Cancel anytime online in your account — it takes effect at the end of your paid month\.$/);
  await expect(page.getByText("The Circle is currently available in the United States.")).toBeVisible();

  const terms = page.getByLabel("I agree to the Membership Terms and to automatic monthly renewal.");
  const age = page.getByLabel("I am 18 or older.");
  const pay = page.getByRole("button", { name: "Continue to payment" });
  await expect(terms).not.toBeChecked();
  await expect(age).not.toBeChecked();
  await expect(pay).toBeDisabled();
  await terms.check();
  await expect(pay).toBeDisabled();
  await age.check();
  await expect(pay).toBeEnabled();
  expect(await a11yViolations(page)).toEqual([]);

  // The fake Checkout "pays" and returns to /circle/welcome?session_id=…
  await pay.click();
  await expect(page).toHaveURL(/\/circle\/welcome\?session_id=cs_e2e_/);
  await expect(page.getByRole("heading", { name: "Choose your sealed piece" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("radio")).toHaveCount(2);
  const choose = page.getByRole("button", { name: "Choose this piece" });
  await expect(choose).toBeDisabled();
  await page.getByRole("radio", { name: /The dish/ }).check();
  expect(await a11yViolations(page)).toEqual([]);
  await choose.click();
  await expect(page.getByRole("heading", { name: "Your piece is chosen" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your first 20 credits are here" })).toBeVisible();
  expect(await page.locator("main").innerText()).not.toMatch(FORBIDDEN_NAMES);

  await page.getByRole("link", { name: "Later" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "The Renaissance Circle" })).toBeVisible();
  await expect(page.locator(".treasury-balance")).toHaveText("20 credits");
  await expect(page.getByText("= $20 to spend in the house")).toBeVisible();
  await expect(page.getByRole("link", { name: "Choose your sealed piece" })).toHaveCount(0);

  // Joining twice is refused calmly.
  await page.goto("/circle/join");
  await expect(page.getByRole("heading", { name: "You're already a member" })).toBeVisible();
});

test("member page: the Treasury, the blocks that apply, billing; axe", async ({ page, request }, info) => {
  await signedInMember(page, request, info, "member");
  await page.goto("/circle");
  await expect(page.getByRole("heading", { level: 1, name: "The Renaissance Circle" })).toBeVisible();
  await expect(page.getByText(/^Member since \w{3} \d{4}$/)).toBeVisible();
  const treasury = page.getByRole("region", { name: "The Treasury" });
  await expect(treasury.locator(".treasury-balance")).toHaveText("20 credits");
  await expect(treasury.getByText(/^\+20 on \w{3} \d{1,2}, \d{4}$/)).toBeVisible();
  await expect(treasury.getByRole("link", { name: "Use credits" })).toHaveAttribute("href", "/circle/credits/use");
  await expect(treasury.getByRole("link", { name: "History" })).toHaveAttribute("href", "/circle/credits");
  await expect(page.getByRole("link", { name: "Choose your sealed piece" })).toHaveAttribute("href", "/circle/welcome");
  // No release open, no gift waiting: those blocks are absent.
  await expect(page.getByRole("region", { name: "The members' object" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Early access" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "A year in the Circle" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Capsules" })).toContainText("Seasonal capsules, reserved for members.");
  await expect(page.getByRole("link", { name: "Write to us" })).toHaveAttribute("href", "/circle/concierge");
  await expect(page.getByRole("link", { name: "Membership & billing" })).toHaveAttribute("href", "/account/membership");
  expect(await a11yViolations(page)).toEqual([]);

  // Home no longer invites a member to Reserve a place.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: "Reserve a place" })).toHaveCount(0);
});

test("credits: history, then Use credits — step-up by code, and Shopify off answers calmly", async ({ page, request }, info) => {
  const email = await signedInMember(page, request, info, "credits", 2);
  await page.goto("/circle/credits");
  await expect(page.getByRole("heading", { level: 1, name: "Credits" })).toBeVisible();
  await expect(page.locator(".treasury-balance")).toHaveText("40 credits");
  const rows = (page.viewportSize()?.width ?? 0) < 768 ? page.locator(".ledger-list li") : page.locator(".ledger-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("+20");
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Use credits" }).click();
  await expect(page).toHaveURL(/\/circle\/credits\/use$/);
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await expect(page.getByLabel("Credits to use")).toHaveValue("40");
  await page.getByLabel("Credits to use").fill("41");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toHaveText("You have 40 credits.");
  await page.getByLabel("Credits to use").fill("15");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await expect(page.locator(".steps-form p").first()).toHaveText("We'll create a single-use gift card for $15. Use it at checkout — any balance left stays on the card.");
  await page.getByRole("button", { name: "Create my card" }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  await expect(dialog.getByLabel("Confirmation code")).toBeVisible();
  await dialog.getByLabel("Confirmation code").fill(await lastStepUpCode(request, email));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("alert")).toHaveText("We couldn't create your card. Your credits are untouched — please try again.");

  await page.goto("/circle/credits");
  await expect(page.locator(".treasury-balance")).toHaveText("40 credits");
});

test("cancel: reason → offer with the facts and both buttons → confirmation → Undo (3 screens, no step-up)", async ({ page, request }, info) => {
  await signedInMember(page, request, info, "cancel");
  await page.goto("/account");
  await page.getByRole("link", { name: "Membership & billing" }).click();
  await expect(page).toHaveURL(/\/account\/membership$/);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Account" })).toHaveAttribute("aria-current", "page");
  const facts = page.locator(".facts");
  await expect(facts).toContainText("Plan$20 / month");
  await expect(facts).toContainText(/Next charge\$20 on \w{3} \d{1,2}, \d{4}/);
  await expect(page.getByRole("button", { name: "Update card" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // Screen 1
  await page.getByRole("button", { name: "Cancel membership" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Before you go" })).toBeVisible();
  await expect(page.getByText("What's prompting this? It helps us improve the Circle.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep my membership" })).toBeVisible();
  await page.getByRole("radio", { name: "I have more credits than I can use" }).check();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 2: one offer, the facts, cancel and keep side by side.
  await expect(page.getByText("You have 20 credits. They also work on Small Pleasures.")).toBeVisible();
  await expect(page.locator(".cancel-facts")).toHaveText(/^If you cancel: your membership ends on (\w{3} \d{1,2}, \d{4}) \(no further charges\)\. Your 20 credits stay usable until \w{3} \d{1,2}, \d{4}, then expire\. Your member price ends on \1\.$/);
  await expect(page.getByRole("button", { name: "Keep my membership" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Cancel membership" }).click();

  // Screen 3
  await expect(page.getByRole("heading", { level: 1, name: /^Your membership will end on \w{3} \d{1,2}, \d{4}\.$/ })).toBeVisible();
  await expect(page.getByText(/^Changed your mind\? You can undo this until/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0); // no step-up

  // The Circle shows the canceling banner; Keep my membership there undoes it.
  await page.goto("/circle");
  await expect(page.locator(".circle-banner")).toHaveText(/Your membership ends \w{3} \d{1,2}, \d{4}\. Credits stay usable until \w{3} \d{1,2}, \d{4}\./);
  await expect(page.getByRole("region", { name: "Invite a friend" })).toHaveCount(0); // no new invitations while canceling
  await page.locator(".circle-banner").getByRole("button", { name: "Keep my membership" }).click();
  await expect(page.locator(".circle-banner")).toHaveCount(0);

  // And Undo on the confirmation screen works too.
  await page.goto("/account/membership");
  await page.getByRole("button", { name: "Cancel membership" }).click();
  await page.getByRole("radio", { name: "I'm spending less for now" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".cancel-offer")).toHaveCount(0); // no offer for this reason
  await page.getByRole("button", { name: "Cancel membership" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status")).toHaveText("Your membership continues.");
  await expect(page.getByRole("button", { name: "Cancel membership" })).toBeVisible();
});

test("invite: the personal link, Copy link, this season's status", async ({ page, request }, info) => {
  await signedInMember(page, request, info, "invite");
  await page.goto("/circle/invite");
  await expect(page.getByRole("heading", { level: 1, name: "Invite a friend" })).toBeVisible();
  await expect(page.getByLabel("Your link")).toHaveValue(/\/circle\/join\?invite=[A-Za-z0-9]+$/);
  await expect(page.getByText(/^Your code: [A-Za-z0-9]+$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  // With no costs entered the economics pause invitations (D31): said plainly.
  await expect(page.getByText(/^(Invitations are paused for now\. A friend who joins with your link pays the usual joining fee\.|Share your link\. Your friend's joining fee is \$\d+ lower, and you receive \d+ credits once they have paid their second month\. One invitation counts each season\.)$/)).toBeVisible();
  await expect(page.getByRole("region", { name: /^This season · \w{3}–\w{3} \d{4}$/ })).toContainText("No invitation has counted this season yet.");
  expect(await a11yViolations(page)).toEqual([]);
});

test("concierge: write, and the message joins the thread (people answer)", async ({ page, request }, info) => {
  await signedInMember(page, request, info, "concierge");
  await page.goto("/circle/concierge");
  await expect(page.getByRole("heading", { level: 1, name: "Concierge" })).toBeVisible();
  await expect(page.getByText("Write to us, and a person answers.")).toBeVisible();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert")).toHaveText("Write a message first.");
  await page.getByRole("textbox", { name: "Your message" }).fill("Could you suggest a vase for a north-facing study?");
  await page.getByRole("button", { name: "Send" }).click();
  const thread = page.getByRole("list", { name: "Your messages" });
  await expect(thread.getByRole("listitem")).toHaveCount(1);
  await expect(thread).toContainText("Could you suggest a vase for a north-facing study?");
  await expect(thread).toContainText(/^You · /);
  await expect(page.getByRole("textbox", { name: "Your message" })).toHaveValue("");
  expect(await page.locator("main").innerText()).not.toMatch(/\bAI\b|assistant|generated/i);
  expect(await a11yViolations(page)).toEqual([]);
});

// A JPEG with an EXIF (APP1) segment, made in the browser.
async function jpegWithExif(page: Page): Promise<Buffer> {
  const bytes: number[] = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 48;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#5e4638"; ctx.fillRect(0, 0, 64, 48);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const exif = [0xFF, 0xE1, 0x00, 0x16, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  return Buffer.from([...bytes.slice(0, 2), ...exif, ...bytes.slice(2)]);
}

test("rooms: the photo is re-encoded without EXIF; without R2 the page says so calmly", async ({ page, request }, info) => {
  await signedInMember(page, request, info, "rooms");
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = async (input, init) => {
      if (init?.method === "PUT" && init.body instanceof Blob) {
        (window as unknown as { __lastPut: number[] }).__lastPut = [...new Uint8Array(await init.body.arrayBuffer())];
      }
      return orig(input, init);
    };
  });
  await page.goto("/circle/rooms");
  await expect(page.getByRole("heading", { level: 1, name: "Your rooms" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No photos yet" })).toBeVisible();
  const file = await jpegWithExif(page);
  expect(file.includes(Buffer.from("Exif"))).toBe(true);

  await page.getByRole("button", { name: "Add photo" }).click();
  await expect(page.getByRole("alert")).toHaveText("Name the room.");
  await page.getByLabel("Room").fill("Study");
  await page.getByLabel("Photo", { exact: true }).setInputFiles({ name: "study.jpg", mimeType: "image/jpeg", buffer: file });
  const put = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/api/circle/rooms?label=Study"));
  await page.getByRole("button", { name: "Add photo" }).click();
  expect((await put).headers()["content-type"]).toBe("image/jpeg");
  // WebKit does not expose a Blob request body to Playwright: read what the
  // page handed to fetch instead (recorded by the init script below).
  const body = Buffer.from(await page.evaluate(() => (window as unknown as { __lastPut: number[] }).__lastPut));
  expect([...body.subarray(0, 3)]).toEqual([0xFF, 0xD8, 0xFF]);
  expect(body.includes(Buffer.from("Exif"))).toBe(false);
  await expect(page.getByText("Room photos are not available yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add photo" })).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);
});

test("Membership Terms: a public draft, marked pending legal review, with counsel placeholders", async ({ page }) => {
  await mockSignedOut(page);
  await page.goto("/terms/membership");
  await expect(page).toHaveTitle("Membership Terms · Spring Renaissance");
  await expect(page.getByRole("heading", { level: 1, name: "Membership Terms" })).toBeVisible();
  await expect(page.getByText("Draft — pending legal review")).toBeVisible();
  await expect(page.getByText("$50 to join, which includes your first month.")).toBeVisible();
  await expect(page.getByText("Then $20 a month, plus applicable tax, until you cancel.")).toBeVisible();
  await expect(page.getByText("Credits stay usable for 30 days after the end of your last paid period, then they expire.")).toBeVisible();
  await expect(page.getByText("A former member can rejoin for $20 a month, with no joining fee. Rejoining does not include a new welcome piece.")).toBeVisible();
  expect(await page.getByText("[Text from counsel]").count()).toBeGreaterThanOrEqual(3);
  await expect(page).toHaveURL(/\/terms\/membership$/); // no redirect to sign-in
  expect(await a11yViolations(page)).toEqual([]);
});
