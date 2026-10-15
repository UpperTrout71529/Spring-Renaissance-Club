import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";

// Turnstile stub: the real script is replaced so tests never call Cloudflare.
// execute() answers with the token the e2e server's fake siteverify accepts.
const TURNSTILE_STUB = `
window.turnstile = {
  render(el, opts) { window.__ts = opts; return "w1"; },
  execute() { setTimeout(() => window.__ts.callback("e2e-token"), 0); },
  reset() {},
};`;

export async function stubTurnstile(page: Page) {
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }));
}

export const USER = { id: "01USER", email: "clara@example.com", first_name: "Clara", tier: "club" };

export async function mockSignedIn(page: Page) {
  await page.route("**/api/me", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: USER, membership: null, badges: { circle: false }, onboarding: { passkey: false, saved: false } }),
    }));
}

export async function mockSignedOut(page: Page) {
  await page.route("**/api/me", (route: Route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unauthenticated", message: "Please sign in to continue." } }),
    }));
}

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

// Real sign-in against the e2e server's Worker: request a link, read it from
// the captured email, open it.
export async function signInByLink(page: Page, request: APIRequestContext, email: string) {
  await stubTurnstile(page);
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  const { link } = await (await request.get(`/__e2e/last-link?email=${encodeURIComponent(email)}`)).json();
  await page.goto(link);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  return link as string;
}

export async function lastStepUpCode(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.get(`/__e2e/last-code?email=${encodeURIComponent(email)}`);
  return (await res.json()).code;
}

// Mocks /api/orders (list, paged by "cursor") and /api/orders/:id.
export async function mockOrders(page: Page, { pages = [] as unknown[][], details = {} as Record<string, unknown>, status = 200 } = {}) {
  await page.route("**/api/orders**", (route) => {
    const url = new URL(route.request().url());
    if (status !== 200) {
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "orders_unavailable", message: "We couldn't load your orders right now. Please try again in a moment." } }) });
    }
    const m = /\/api\/orders\/([^/?]+)/.exec(url.pathname);
    if (m) {
      const order = details[m[1]];
      return order
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ order }) })
        : route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: "Not found." } }) });
    }
    const i = Number(url.searchParams.get("cursor") || 0);
    const orders = pages[i] ?? [];
    const next = i + 1 < pages.length ? String(i + 1) : null;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ orders, next_cursor: next }) });
  });
}
