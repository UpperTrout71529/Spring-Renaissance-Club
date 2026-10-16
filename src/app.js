// The portal API (spec §8) in front of the legacy worker.
//
// Requests whose path a route owns are handled here: CORS, the Origin and
// X-SR-Client checks, session auth and the §8 error shape. Every other path
// falls through to worker.js unchanged — including its catch-all Stripe
// webhook, which answers any POST to an unknown path and must keep doing so
// until the V2 webhook moves to /webhooks/stripe.

import legacyWorker from "../worker.js";
import { createRouter } from "./http/router.js";
import { HttpError, errorBody, forbidden, unauthenticated } from "./http/errors.js";
import { assertTrustedMutation, corsHeaders, isAllowedOrigin, preflightHeaders } from "./http/cors.js";
import { loadSession } from "./auth/session.js";
import { ulid } from "./lib/ulid.js";
import { health } from "./routes/health.js";
import { getMe, patchMe } from "./routes/me.js";
import { logout, requestMagicLink, verifyMagicLink } from "./routes/auth.js";
import {
  deletePasskey, listPasskeys, loginOptions, loginVerify, registerOptions, registerVerify, stepUpPasskeyOptions,
} from "./routes/passkeys.js";
import { sendStepUpCode, verifyStepUp } from "./routes/step-up.js";
import { getOrder, listOrders } from "./routes/orders.js";
import { listGiftCards } from "./routes/gift-cards.js";
import { addHold, addToWishlist, listHolds, listWishlist, removeFromWishlist, wishlistHandles } from "./routes/saved.js";
import { getTeaser, joinWaitlist } from "./routes/circle.js";
import {
  confirmEmailChange, deleteAccount, exportAccount, listSessions, requestEmailChange, revokeOneSession, revokeOtherSessions,
} from "./routes/account.js";
import { getMember, getMetrics, listAudit, listEmails, listMembers, listWebhooks, serveAdmin } from "./routes/admin.js";
import { verifyAdmin } from "./admin/access.js";
import { postEvent } from "./routes/events.js";
import { shopifyWebhook } from "./routes/webhooks-shopify.js";

// Route options:
//   auth: "session"   — 401 without a live session; ctx.session is set
//   auth: "optional"  — ctx.session is set when there is one
//   auth: "admin"     — 403 without a verified Cloudflare Access JWT for an
//                       email in ADMIN_EMAILS; ctx.admin = { email }
//   crossSite: true   — skip the Origin / X-SR-Client check (server-to-server
//                       callers such as webhooks, which send neither)
export const ROUTES = [
  { method: "GET", path: "/health", handler: health },
  { method: "POST", path: "/api/auth/magic-link", handler: requestMagicLink },
  { method: "POST", path: "/api/auth/verify", handler: verifyMagicLink },
  { method: "POST", path: "/api/auth/logout", handler: logout, auth: "optional" },
  { method: "POST", path: "/api/auth/passkey/register/options", handler: registerOptions, auth: "session" },
  { method: "POST", path: "/api/auth/passkey/register/verify", handler: registerVerify, auth: "session" },
  { method: "POST", path: "/api/auth/passkey/login/options", handler: loginOptions },
  { method: "POST", path: "/api/auth/passkey/login/verify", handler: loginVerify },
  { method: "POST", path: "/api/auth/step-up/email-code", handler: sendStepUpCode, auth: "session" },
  { method: "POST", path: "/api/auth/step-up/passkey/options", handler: stepUpPasskeyOptions, auth: "session" },
  { method: "POST", path: "/api/auth/step-up/verify", handler: verifyStepUp, auth: "session" },
  { method: "GET", path: "/api/passkeys", handler: listPasskeys, auth: "session" },
  { method: "DELETE", path: "/api/passkeys/:credential_id", handler: deletePasskey, auth: "session" },
  { method: "GET", path: "/api/me", handler: getMe, auth: "session" },
  { method: "PATCH", path: "/api/me", handler: patchMe, auth: "session" },
  { method: "GET", path: "/api/gift-cards", handler: listGiftCards, auth: "session" },
  { method: "GET", path: "/api/wishlist", handler: listWishlist, auth: "session" },
  { method: "POST", path: "/api/wishlist", handler: addToWishlist, auth: "session" },
  { method: "GET", path: "/api/wishlist/handles", handler: wishlistHandles, auth: "session" },
  { method: "DELETE", path: "/api/wishlist/:product_handle", handler: removeFromWishlist, auth: "session" },
  { method: "GET", path: "/api/holds", handler: listHolds, auth: "session" },
  { method: "POST", path: "/api/holds", handler: addHold, auth: "session" },
  { method: "POST", path: "/api/me/email-change", handler: requestEmailChange, auth: "session" },
  { method: "POST", path: "/api/me/email-change/confirm", handler: confirmEmailChange },
  { method: "GET", path: "/api/sessions", handler: listSessions, auth: "session" },
  { method: "DELETE", path: "/api/sessions", handler: revokeOtherSessions, auth: "session" },
  { method: "DELETE", path: "/api/sessions/:id", handler: revokeOneSession, auth: "session" },
  { method: "GET", path: "/api/account/export", handler: exportAccount, auth: "session" },
  { method: "DELETE", path: "/api/account", handler: deleteAccount, auth: "session" },
  { method: "GET", path: "/api/circle/teaser", handler: getTeaser, auth: "session" },
  { method: "POST", path: "/api/circle/waitlist", handler: joinWaitlist, auth: "session" },
  { method: "GET", path: "/api/orders", handler: listOrders, auth: "session" },
  { method: "GET", path: "/api/orders/:id", handler: getOrder, auth: "session" },
  { method: "POST", path: "/webhooks/shopify", handler: shopifyWebhook, crossSite: true },
  { method: "POST", path: "/api/events", handler: postEvent, auth: "session" },
  { method: "GET", path: "/api/admin/members", handler: listMembers, auth: "admin" },
  { method: "GET", path: "/api/admin/members/:id", handler: getMember, auth: "admin" },
  { method: "GET", path: "/api/admin/metrics", handler: getMetrics, auth: "admin" },
  { method: "GET", path: "/api/admin/webhooks", handler: listWebhooks, auth: "admin" },
  { method: "GET", path: "/api/admin/emails", handler: listEmails, auth: "admin" },
  { method: "GET", path: "/api/admin/audit", handler: listAudit, auth: "admin" },
  { method: "GET", path: "/admin", handler: serveAdmin, auth: "admin" },
  { method: "GET", path: "/admin/:file", handler: serveAdmin, auth: "admin" },
];

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'",
  "Cache-Control": "no-store",
};

// now, randomBytes and fetch are injected so tests control time, tokens, IDs
// and every outbound call (Resend, Turnstile, Shopify).
export function createApp({
  routes = ROUTES,
  legacy = legacyWorker,
  now = () => Date.now(),
  randomBytes,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const router = createRouter(routes);

  return {
    async fetch(request, env, executionCtx) {
      const url = new URL(request.url);
      const match = router.match(request.method, url.pathname);
      if (!match) {
        // V2 §14: LEGACY_VIP = "off" retires the old VIP system (worker.js:
        // /api/user/*, the Gemini curator, the old sign-in link and the
        // catch-all Stripe webhook) without deleting it. Unset = unchanged.
        if (env && env.LEGACY_VIP === "off") {
          return new Response(JSON.stringify(errorBody("legacy_retired", "This service has moved.")), {
            status: 410,
            headers: { ...SECURITY_HEADERS, "Content-Type": "application/json", ...corsHeaders(request.headers.get("Origin"), env) },
          });
        }
        return legacy.fetch(request, env, executionCtx);
      }

      const origin = request.headers.get("Origin");
      const baseHeaders = { ...SECURITY_HEADERS, ...corsHeaders(origin, env) };
      const cookies = [];

      // Every response leaving an owned route gets the base headers (unless
      // the handler set its own) and any cookies queued during the request —
      // error responses included, so a refreshed session survives a 4xx.
      const finalize = (response) => {
        const res = new Response(response.body, response);
        for (const [k, v] of Object.entries(baseHeaders)) {
          if (!res.headers.has(k)) res.headers.set(k, v);
        }
        for (const c of cookies) res.headers.append("Set-Cookie", c);
        return res;
      };
      const json = (body, status = 200, headers = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", ...headers },
        });

      try {
        if (request.method === "OPTIONS") {
          if (!isAllowedOrigin(origin, env)) {
            throw forbidden("origin_not_allowed", "This request is not allowed from here.");
          }
          return new Response(null, {
            status: 204,
            headers: { ...SECURITY_HEADERS, ...preflightHeaders(origin, env, match.allowed) },
          });
        }

        if (!match.route) {
          throw new HttpError(405, "method_not_allowed", "This method is not allowed here.", {
            Allow: match.allowed.join(", "),
          });
        }
        const route = match.route;
        if (!route.crossSite) assertTrustedMutation(request, env);

        const nowMs = now();
        const ctx = {
          request,
          env,
          url,
          params: match.params,
          json,
          fetch: fetchImpl,
          randomBytes,
          now: () => nowMs,
          nowIso: () => new Date(nowMs).toISOString(),
          newId: () => ulid(nowMs, randomBytes),
          setCookie: (c) => cookies.push(c),
          // Work that must outlive the response (email, Shopify). Without a
          // runtime context (tests that pass none) it simply runs detached.
          waitUntil: (p) => {
            const guarded = Promise.resolve(p).catch((e) => console.error("background task failed", e && e.name));
            if (executionCtx && typeof executionCtx.waitUntil === "function") executionCtx.waitUntil(guarded);
          },
          session: null,
        };

        if (route.auth === "admin") {
          ctx.admin = await verifyAdmin(request, env, fetchImpl, nowMs);
        }
        if (route.auth === "session" || route.auth === "optional") {
          ctx.session = await loadSession(request, env, nowMs);
          if (!ctx.session && route.auth === "session") throw unauthenticated();
          if (ctx.session && ctx.session.cookie) cookies.push(ctx.session.cookie);
        }

        return finalize(await route.handler(ctx));
      } catch (e) {
        if (e instanceof HttpError) return finalize(json(errorBody(e.code, e.message), e.status, e.headers));
        // No request data in the log line: it can carry personal data.
        console.error("unhandled error", url.pathname, e && e.name, e && e.message);
        return finalize(json(errorBody("internal_error", "Something went wrong. Please try again."), 500));
      }
    },
  };
}
