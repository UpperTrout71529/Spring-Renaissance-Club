# V1 launch (S11): staging, QA, production steps

Status 16 Oct 2026. **Production: nothing changed.** Every production step
below waits for Felix's "yes"; so does any DNS record (staging included).

## 1. Staging

| Piece | State |
|---|---|
| D1 `spring-renaissance-staging` (`cf5418bc-d6ad-4b14-bf82-09701f6fb996`, ENAM) | **created**; migrations 0000–0005 applied and recorded in `d1_migrations` (wrangler's format, so `wrangler d1 migrations apply --env staging --remote` sees nothing pending); schema identical to the local one |
| KV `CLIENT_KV_STORE_STAGING` | **not created** — the connector call was refused by the permission check; needs Felix's OK (or one click in the dashboard), then its id goes into `wrangler.toml` `[[env.staging.kv_namespaces]]` |
| Worker `stripe-magiclink-staging` | config in `wrangler.toml` `[env.staging]` (own D1/KV, assets, cron, vars); `wrangler deploy --env staging --dry-run` builds. **Not deployed**: wrangler on this machine is not signed in (`wrangler login`, or a scoped API token in the shell, by Felix) |
| Staging secrets | `SESSION_PEPPER` (any random 32+ bytes), `RESEND_API_KEY` (the same key works; mail goes to real inboxes), `TURNSTILE_SECRET` = Cloudflare's always-pass test secret `1x0000000000000000000000000000000AA` |
| Shopify on staging | **off on purpose** (no `SHOPIFY_SHOP`): a staging sign-in must not create customers or tags in the live store. Orders/gift cards show their "unavailable" state there |
| Portal staging build | `npm run build:staging` (`portal/.env.staging`: API `https://api-staging.springrenaissance.store`, Turnstile always-pass test site key, no FAQ) → `portal/dist-staging`; CSP checked (connect-src = api-staging) |
| Pages project for staging | **not created** (needs wrangler auth): `wrangler pages project create spring-renaissance-club-staging`, then `wrangler pages deploy portal/dist-staging --project-name spring-renaissance-club-staging` |
| Domains `api-staging.` / `club-staging.springrenaissance.store` | **DNS — needs Felix's "yes"**. Needed for the real cookie check: on `*.workers.dev` + `*.pages.dev` the API and the portal are cross-site, so the SameSite=Lax session cookie is (correctly) not sent and WebKit would block it anyway. Worker: `routes = [{ pattern = "api-staging.springrenaissance.store", custom_domain = true }]` under `[env.staging]`; Pages: custom domain `club-staging.` on the staging project |

Once those are in: `E2E_BASE_URL`-style run of the e2e suite against
staging is the S11 "cross-subdomain cookie in WebKit" check (sign in by link
in WebKit, reload, still signed in; passkey sign-in in Chromium).

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

- [ ] Staging: KV OK, `wrangler login`, DNS for `api-staging.` / `club-staging.`
- [ ] Staging e2e green in WebKit and Chromium (Claude runs it)
- [ ] Theme edits in the draft approved (header + footer "Account")
- [ ] Production steps 1–7 above, each with a "yes"
- [ ] Sign-in email lands in the inbox at Gmail, Outlook, iCloud
- [ ] Copy read and corrected (`docs/v1-decisions.md` → "Copy for review")
- [ ] Privacy policy: a section about the account portal
- [ ] Theme published
