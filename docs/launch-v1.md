# V1 launch (S11): staging, QA, production steps

Status 16 Oct 2026. **Production: nothing changed.** Every production step
below waits for Felix's "yes"; so does any DNS record (staging included).

## 1. Staging (live since 16 Oct 2026, Felix's yes)

| Piece | State |
|---|---|
| D1 `spring-renaissance-staging` (`cf5418bc-…`, ENAM) | created, migrations 0000–0005 applied (recorded in `d1_migrations`) |
| KV `CLIENT_KV_STORE_STAGING` (`040632c8…`) | created by Felix |
| Worker `stripe-magiclink-staging` | deployed (`wrangler deploy --env staging`), custom domain **https://api-staging.springrenaissance.store**, daily cron |
| Staging secrets | `SESSION_PEPPER` (random, never printed), `TURNSTILE_SECRET` (Cloudflare's always-pass test secret). **`RESEND_API_KEY` missing** — sign-in emails are not sent on staging until Felix sets it: `npx.cmd wrangler secret put RESEND_API_KEY --env staging` |
| Shopify on staging | off on purpose (no `SHOPIFY_SHOP`): staging sign-ins never touch the live store |
| Pages `spring-renaissance-club-staging` | deployed from `npm run build:staging`; custom domain **https://club-staging.springrenaissance.store** (CNAME → `spring-renaissance-club-staging.pages.dev`, proxied; added in the dashboard) — active |
| Production | untouched (Worker `stripe-magiclink`, D1 `spring-renaissance`, Pages `spring-renaissance-club`, DNS records other than the two staging names) |

**Smoke on staging** (`node portal/e2e/staging-smoke.mjs`, Chromium + WebKit,
375 px): signed-out deep link → `/login?return_to=…`; CSP meta; the sign-in
form posts cross-subdomain with credentials → 202, CORS allows exactly
`club-staging.`; "Check your inbox"; no console errors; `/health` 200;
`/api/me` 401; `/api/admin/*` 403 (no Access); foreign Origin 403 — all ok.

**Still to do:** the full sign-in in WebKit (open the link from the email →
signed in → reload → still signed in), which needs `RESEND_API_KEY` on
staging and a real inbox — Felix in Safari, or Claude reading the link from
an inbox Felix names.

## 2. QA done locally (all green, 16 Oct)

- Worker `npm test`: 328 tests. Portal unit: 13. e2e (Chromium + WebKit,
  375 and 1280): see the PR comment for the run of this commit.
- Lighthouse, signed-in Home, mobile, **Slow 4G** (simulated: 150 ms RTT,
  1.6 Mbps, 4× CPU): **LCP ≈ 2.0 s** (budget 2.5 s), FCP ≈ 1.36 s, CLS 0.000,
  performance 99. `/login` accessibility 100/100 (mobile and desktop).
  The e2e server now gzips like Cloudflare Pages does; uncompressed it read
  2.6 s, which was the measurement, not the site.
- Fixed on the way: Home asked `/api/me` twice (App already had it); a slow
  orders answer moved the blocks below it (CLS 0.083) — they now wait for the
  order block. Both covered by e2e.

## 3. Security pass (spec §13.1)

| Item | Result |
|---|---|
| Secrets only via `wrangler secret`; `.dev.vars.example` without values | ✓ no keys in tracked files (grep for Stripe/Resend/Shopify key shapes); `.dev.vars`, `.env.local` ignored |
| Webhook signatures + dedupe by event id | ✓ Stripe (legacy handler, constant-time HMAC, `processed_events`); Shopify (S10, HMAC over raw body, `webhook_events`). **Fixed:** a signed but unparseable Shopify body stored V8's parse message, which can quote the body (customer data) — now "invalid payload" (test) |
| Money in integer cents | ✓ `toCents` everywhere money enters; no floats stored |
| Every query scoped to the session's user | ✓ all routes with an id in the URL bind `session.user.id`; ownership tests in S5 (orders 404), S6, S7, S9 |
| CORS: two origins, credentials, never `*` | ✓ (test S1); preflight refused for other origins |
| Portal CSP | ✓ as §13.1 plus `cloudflareinsights.com` (Web Analytics beacon); admin page has its own stricter CSP |
| No trackers in the portal | ✓ the production bundle names only our API, cdn.shopify.com, Turnstile and Cloudflare Web Analytics |
| Logs without personal data | **Fixed:** three legacy `worker.js` lines logged a raw email or IP (Stripe "no subscription", billing portal, rate limiter) — now masked / dropped |
| Pinned dependencies, `npm audit` in CI | ✓ exact versions; audit in worker-ci and portal-ci; 0 vulnerabilities today |
| §13.2 retention | **Added:** daily cron (03:15 UTC) deletes sessions 30 days after they end, spent/expired links and challenges after a day, events after 13 months (tests). Active only after the deploy |
| Admin | ✓ Access JWT verified in the Worker (S10); fails closed |

Open (not code): the privacy policy section about the portal (§13.3, §14)
and the Circle FAQ legal review (P0.7) — both Felix/lawyer.

## 4. Production — steps for Felix's "yes" (do not run before)

Order matters (see `docs/rollout-s1.md` for why migrations and deploy go back
to back, and for the rollback scripts).

1. **P0.2 domain:** Worker custom domain `api.springrenaissance.store`
   (a DNS record — "yes" needed). Check `GET /health` → 200.
2. **Secrets / vars** on `stripe-magiclink`: `SESSION_PEPPER`,
   `TURNSTILE_SECRET`, `RESEND_API_KEY` (exists), `SHOPIFY_CLIENT_ID`,
   `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET`; plain: `ADMIN_NOTIFY_EMAIL`,
   `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` (S10 rollout).
3. **Rollback points:** `wrangler deployments list` (V_OLD),
   `wrangler d1 time-travel info spring-renaissance` (B_OLD).
4. **Migrations + Worker, back to back:**
   `wrangler d1 migrations apply spring-renaissance --remote`, then at once
   `wrangler deploy` (the top-level config; wrangler warns that environments
   exist — that is expected). This also uploads `public/admin/` and turns on
   the daily cron.
5. **Smoke:** `/health` 200; `/api/me` 401 in the `{error:{code}}` shape;
   `/admin` 403 without Access; legacy `/api/user?auth_token=x` 401; Stripe
   test event → not 500.
6. **Portal on Cloudflare Pages** (`spring-renaissance-club`, serves
   `club.`): build `npm ci && npm run build` in `portal/`, output
   `portal/dist`, variables `VITE_API_BASE=https://api.springrenaissance.store`,
   `VITE_TURNSTILE_SITE_KEY=<club. widget>`; no `VITE_CIRCLE_FAQ`. Check
   `https://club.springrenaissance.store/login` loads and a sign-in works end
   to end in Safari and Chrome.
7. **S10:** Access application and Shopify `orders/create` webhook
   (`docs/rollout-s10-admin.md`; Felix: done by Claude in Felix's browser).
8. **Theme:** Felix publishes the draft 189482795229 (Save button, Account
   links) when ready.
9. **Felix by hand:** the sign-in email from Gmail, Outlook and iCloud —
   inbox, not spam; the link opens and signs in.

Rollback: `wrangler rollback V_OLD` + Time Travel to B_OLD (within 7 days),
or `scripts/rollback/s1_down.sql` right after the rollout — both in
`docs/rollout-s1.md`. The Pages project keeps its previous deployment one
click away ("Rollback to this deployment").

## 5. Launch checklist for Felix

- [x] Staging: KV, `wrangler login`, `api-staging.` / `club-staging.` (16 Oct)
- [ ] `RESEND_API_KEY` on staging, then the full sign-in in Safari
- [x] Staging smoke green in WebKit and Chromium (16 Oct)
- [x] Footer "Account" and header-actions uploaded to the draft (MD5 checked)
- [ ] Header "Account" in `sections/sr-header.liquid` (the draft's real header) — prepared, waiting for yes
- [ ] Production steps 1–7 above, each with a "yes"
- [ ] Sign-in email lands in the inbox at Gmail, Outlook, iCloud
- [ ] Copy read and corrected (`docs/v1-decisions.md` → "Copy for review")
- [ ] Privacy policy: a section about the account portal
- [ ] Theme published
