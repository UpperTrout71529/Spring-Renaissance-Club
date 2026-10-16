// S9 acceptance (§6.8, §13.3–13.4): profile, the seasonal switch, email
// change through step-up, sessions, the email-confirm page; and against the
// real Worker: download my data, delete the account, sign up afresh.

import { expect, test, type Page } from "@playwright/test";
import { a11yViolations, lastStepUpCode, mockSignedIn, signInByLink } from "./helpers";

const ME = {
  user: { id: "01USER", email: "clara@example.com", first_name: "Clara", last_name: null, tier: "club", created_at: "2026-10-02T09:00:00Z", seasonal_email_opt_in: false },
  membership: null, badges: { circle: false }, onboarding: { passkey: true, saved: true, dismissed: false },
};

async function mockMe(page: Page) {
  const patches: unknown[] = [];
  const me = structuredClone(ME);
  await page.route("**/api/me", async (route) => {
    if (route.request().method() === "PATCH") {
      const b = route.request().postDataJSON();
      patches.push(b);
      Object.assign(me.user, b);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) });
  });
  return patches;
}

test.describe("mocked API", () => {
  test("profile: names save with PATCH; the seasonal switch carries the exact consent words", async ({ page }) => {
    const patches = await mockMe(page);
    await page.goto("/account");
    await page.getByLabel("Last name").fill("Duval");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");
    expect(patches[0]).toEqual({ first_name: "Clara", last_name: "Duval" });

    const seasonal = page.getByLabel("Send me the seasonal letter — one email each season. You can turn it off at any time.");
    await seasonal.check();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ seasonal_email_opt_in: true });
    await expect(page.getByText("Emails about signing in, your orders and your account are always sent.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "https://springrenaissance.store/policies/privacy-policy");
  });

  test("change email: step-up by code, then the confirmation notice", async ({ page }) => {
    await mockMe(page);
    let steppedUp = false;
    let sentBody: unknown = null;
    await page.route("**/api/me/email-change", (r) => {
      if (!steppedUp) {
        return r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "step_up_required", message: "Please confirm it's you to continue." } }) });
      }
      sentBody = r.request().postDataJSON();
      return r.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' });
    });
    await page.route("**/api/passkeys", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"passkeys":[]}' }));
    await page.route("**/api/auth/step-up/email-code", (r) => r.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' }));
    await page.route("**/api/auth/step-up/verify", (r) => { steppedUp = true; return r.fulfill({ status: 204 }); });

    await page.goto("/account");
    await page.getByRole("button", { name: "Change email" }).click();
    await page.getByLabel("New email address").fill("new@example.com");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await dialog.getByRole("button", { name: "Email me a code" }).click();
    await dialog.getByLabel("Confirmation code").fill("123456");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("We sent a link to new@example.com. Your email changes once you confirm it.")).toBeVisible();
    expect(sentBody).toEqual({ new_email: "new@example.com" });
  });

  test("an address that already has an account shows the spec's message", async ({ page }) => {
    await mockMe(page);
    await page.route("**/api/me/email-change", (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "email_taken", message: "That email already has an account. Sign in with it, or write to the concierge to merge accounts." } }) }));
    await page.goto("/account");
    await page.getByRole("button", { name: "Change email" }).click();
    await page.getByLabel("New email address").fill("david@example.com");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByRole("alert")).toHaveText("That email already has an account. Sign in with it, or write to the concierge to merge accounts.");
  });

  test("sessions: this device marked; sign out another; sign out everywhere else", async ({ page }) => {
    await mockSignedIn(page);
    await page.route("**/api/passkeys", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"passkeys":[]}' }));
    const sessions = [
      { id: "a".repeat(64), current: true, auth_method: "magic_link", ua_summary: "Safari on iPhone", geo_city: "Brooklyn", last_seen_at: "2026-10-16T10:00:00Z" },
      { id: "b".repeat(64), current: false, auth_method: "passkey", ua_summary: "Chrome on Mac", geo_city: null, last_seen_at: "2026-10-12T10:00:00Z" },
      { id: "c".repeat(64), current: false, auth_method: "magic_link", ua_summary: null, geo_city: null, last_seen_at: "2026-10-01T10:00:00Z" },
    ];
    const deletes: string[] = [];
    await page.route("**/api/sessions**", (r) => {
      if (r.request().method() === "DELETE") {
        const path = new URL(r.request().url()).pathname;
        deletes.push(path);
        if (path.endsWith("/api/sessions")) sessions.splice(1);
        else sessions.splice(sessions.findIndex((s) => path.endsWith(s.id)), 1);
        return r.fulfill({ status: 204 });
      }
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions }) });
    });
    await page.goto("/account/security");
    const list = page.getByRole("region", { name: "Active sessions" });
    await expect(list.getByText("Safari on iPhone · Brooklyn — This device")).toBeVisible();
    await expect(list.getByText("Signed in with a passkey · Last active Oct 12, 2026")).toBeVisible();
    await list.getByRole("button", { name: "Sign out Chrome on Mac" }).click();
    await expect(list.getByText("Chrome on Mac")).toHaveCount(0);
    await list.getByRole("button", { name: "Sign out everywhere else" }).click();
    await expect(list.getByText("Unknown device")).toHaveCount(0);
    expect(deletes).toEqual([`/api/sessions/${"b".repeat(64)}`, "/api/sessions"]);
    expect(await a11yViolations(page)).toEqual([]);
  });

  test("email confirm page: success, and an expired link", async ({ page }) => {
    let status = 200;
    await page.route("**/api/me/email-change/confirm", (r) => status === 200
      ? r.fulfill({ status: 200, contentType: "application/json", body: '{"email":"new@example.com"}' })
      : r.fulfill({ status: 410, contentType: "application/json", body: '{"error":{"code":"link_expired","message":"x"}}' }));
    await page.goto(`/account/email#t=${"T".repeat(43)}`);
    await expect(page.getByRole("heading", { name: "Your email is now new@example.com." })).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe("");
    status = 410;
    await page.goto("about:blank"); // a fresh load, as from an email client
    await page.goto(`/account/email#t=${"U".repeat(43)}`);
    await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  });

  test("axe: Account and Privacy have no WCAG 2.2 A/AA violations", async ({ page }) => {
    await mockMe(page);
    await page.goto("/account");
    await expect(page.getByLabel("First name")).toHaveValue("Clara");
    expect(await a11yViolations(page)).toEqual([]);
    await page.goto("/account/privacy");
    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByText("Delete account? Your saved pieces and holds are erased and you are signed out everywhere. Orders stay on record for tax purposes.")).toBeVisible();
    expect(await a11yViolations(page)).toEqual([]);
  });
});

test.describe("real Worker", () => {
  async function stepUpByCode(page: Page, request: Parameters<typeof signInByLink>[1], email: string) {
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await dialog.getByRole("button", { name: "Email me a code" }).click();
    await expect(dialog.getByLabel("Confirmation code")).toBeVisible();
    await dialog.getByLabel("Confirmation code").fill(await lastStepUpCode(request, email));
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(dialog).toBeHidden();
  }

  test("download my data: step-up, then a JSON file with this account", async ({ page, request }, info) => {
    const email = `export-${info.project.name}-${Date.now()}@example.com`;
    await signInByLink(page, request, email);
    await page.goto("/account/privacy");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download my data" }).click();
    await stepUpByCode(page, request, email);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^spring-renaissance-account-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
    expect(data.profile.email).toBe(email);
  });

  test("delete account: step-up, signed out with a notice; the same email then starts a new, empty account", async ({ page, request }, info) => {
    const email = `delete-${info.project.name}-${Date.now()}@example.com`;
    await signInByLink(page, request, email);
    await page.goto("/account/privacy");
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("group").getByRole("button", { name: "Delete account" }).click();
    await stepUpByCode(page, request, email);
    await expect(page).toHaveURL(/\/login\?deleted=1$/);
    await expect(page.getByRole("status")).toHaveText("Your account has been deleted.");

    await page.reload();
    await expect(page.getByLabel("Email address")).toBeVisible(); // no session survived
    await signInByLink(page, request, email);
    await page.goto("/account");
    await expect(page.getByLabel("First name")).toHaveValue("");
  });
});
