// S4 acceptance with a virtual authenticator (Chrome DevTools WebAuthn domain)
// against the real Worker: add a passkey, sign in without an email, remove a
// key only after step-up (passkey, or the emailed code).

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { isMobile, lastStepUpCode, signInByLink } from "./helpers";

test.skip(({ browserName }) => browserName !== "chromium", "virtual authenticator needs the Chrome DevTools Protocol");

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return {
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
  };
}

async function signOut(page: Page) {
  if (isMobile(page)) {
    await page.getByRole("link", { name: "Account" }).click();
    await page.getByRole("main").getByRole("button", { name: "Sign out" }).click();
  } else {
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Sign out" }).click();
  }
  await expect(page).toHaveURL(/\/login$/);
}

async function openSecurity(page: Page) {
  await page.getByRole("link", { name: "Account" }).click();
  await page.getByRole("link", { name: "Sign-in & security" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign-in & security" })).toBeVisible();
}

async function addPasskeyAndSignOut(page: Page, request: Parameters<typeof signInByLink>[1], email: string) {
  const auth = await virtualAuthenticator(page);
  await signInByLink(page, request, email);
  await openSecurity(page);
  await expect(page.getByRole("heading", { name: "No passkeys yet" })).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(1);
  await expect(page.getByText("Not used yet")).toBeVisible();
  expect(await auth.credentials()).toHaveLength(1);
}

test("sign in with the passkey button, no email typed", async ({ page, request }, info) => {
  // Switch conditional UI off so the explicit button is what signs in.
  await page.addInitScript(() => {
    if (window.PublicKeyCredential) PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  });
  await addPasskeyAndSignOut(page, request, `pk-btn-${info.project.name}-${Date.now()}@example.com`);
  await signOut(page);
  await expect(page.getByLabel("Email address")).toHaveValue("");
  await page.getByRole("button", { name: "Sign in with your device" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // The session survives a reload, like a link sign-in.
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("conditional UI: the saved passkey signs in from the email field's autofill", async ({ page, request }, info) => {
  await addPasskeyAndSignOut(page, request, `pk-auto-${info.project.name}-${Date.now()}@example.com`);
  // The virtual authenticator answers the pending autofill request itself,
  // as a person picking the passkey from the suggestions would.
  const verified = page.waitForResponse((r) => r.url().endsWith("/api/auth/passkey/login/verify"));
  await signOut(page).catch(() => {});
  expect((await verified).status()).toBe(200);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveCount(0);
});

test("removing a passkey asks for step-up; confirming with the passkey removes it", async ({ page, request }, info) => {
  await virtualAuthenticator(page);
  await signInByLink(page, request, `pk-rm-${info.project.name}-${Date.now()}@example.com`);
  await openSecurity(page);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.getByRole("button", { name: /^Remove / }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);

  await dialog.getByRole("button", { name: "Confirm with your device" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "No passkeys yet" })).toBeVisible();
});

test("step-up by emailed code: a wrong code is refused, the right one removes the key", async ({ page, request }, info) => {
  await virtualAuthenticator(page);
  const email = `pk-code-${info.project.name}-${Date.now()}@example.com`;
  await signInByLink(page, request, email);
  await openSecurity(page);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.getByRole("button", { name: /^Remove / }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  await expect(dialog.getByText(`We sent a 6-digit code to ${email}. It works for 10 minutes.`)).toBeVisible();
  const code = await lastStepUpCode(request, email);
  const input = dialog.getByLabel("Confirmation code");

  await input.fill(code === "000000" ? "000001" : "000000");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That code isn't right. Please check it and try again.");
  await expect(input).toHaveAttribute("aria-invalid", "true");

  await input.fill(code);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "No passkeys yet" })).toBeVisible();
});

test("axe: Sign-in & security has no WCAG 2.2 A/AA violations", async ({ page, request }, info) => {
  await virtualAuthenticator(page);
  await signInByLink(page, request, `pk-axe-${info.project.name}-${Date.now()}@example.com`);
  await openSecurity(page);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(1);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
