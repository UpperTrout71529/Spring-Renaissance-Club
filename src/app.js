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
import { getMe } from "./routes/me.js";

// Route options:
//   auth: "session"   — 401 without a live session; ctx.session is set
//   crossSite: true   — skip the Origin / X-SR-Client check (server-to-server
//                       callers such as webhooks, which send neither)
export const ROUTES = [
  { method: "GET", path: "/health", handler: health },
  { method: "GET", path: "/api/me", handler: getMe, auth: "session" },
];

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'",
  "Cache-Control": "no-store",
};

// now and randomBytes are injected so tests control time and IDs.
export function createApp({
  routes = ROUTES,
  legacy = legacyWorker,
  now = () => Date.now(),
  randomBytes,
} = {}) {
  const router = createRouter(routes);

  return {
    async fetch(request, env, executionCtx) {
      const url = new URL(request.url);
      const match = router.match(request.method, url.pathname);
      if (!match) return legacy.fetch(request, env, executionCtx);

      const origin = request.headers.get("Origin");
      const baseHeaders = { ...SECURITY_HEADERS, ...corsHeaders(origin, env) };
      const json = (body, status = 200, headers = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { ...baseHeaders, "Content-Type": "application/json", ...headers },
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
          executionCtx,
          url,
          params: match.params,
          json,
          now: () => nowMs,
          nowIso: () => new Date(nowMs).toISOString(),
          newId: () => ulid(nowMs, randomBytes),
          session: null,
        };

        if (route.auth === "session") {
          ctx.session = await loadSession(request, env, ctx.nowIso());
          if (!ctx.session) throw unauthenticated();
        }

        return await route.handler(ctx);
      } catch (e) {
        if (e instanceof HttpError) return json(errorBody(e.code, e.message), e.status, e.headers);
        // No request data in the log line: it can carry personal data.
        console.error("unhandled error", url.pathname, e && e.name, e && e.message);
        return json(errorBody("internal_error", "Something went wrong. Please try again."), 500);
      }
    },
  };
}
