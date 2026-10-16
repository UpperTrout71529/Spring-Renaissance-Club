# Security pass S11 (16 Oct 2026)

Felix's brief: the error classes AI agents miss most (Tenzai): authorisation,
business logic, brute force, SSRF, open data, session/CSRF, injection/XSS.
Method: inventory every route (portal API `src/`, legacy `worker.js`, admin,
webhooks), write an attack test (two accounts A and B), red if there is a hole,
fix, green. New attack tests: `test/s11_security.test.mjs` (17),
`portal/e2e/xss.spec.ts` (2 × 4 browsers). Production was not touched.

## Findings fixed in this pass

| # | Finding | Fix | Test (red → green) |
|---|---|---|---|
| F1 | `/api/sessions` returned `id_hash`, the database key of each session (SHA-256 of token + pepper) | the client now gets an opaque id derived from it; revoke looks it up among the caller's own sessions only | `s11_security`: "IDOR: the sessions list exposes no database key", "no response … carries … any session hash" |
| F2 | (S11, earlier today) Shopify webhook stored V8's JSON error, which can quote the body | stored as "invalid payload" | `s10_shopify_webhook`: "a body that is not JSON…" |
| F3 | (S11, earlier today) three legacy log lines wrote a raw email / IP | masked / dropped | review + suite |

## Open finding — needs Felix's "yes" (production)

| # | Finding | Proposed fix |
|---|---|---|
| P1 | **Production `club.springrenaissance.store` publishes the root of the `main` branch**: the Pages project `spring-renaissance-club` is wired to this repo with an empty build command and output directory, so `/worker.js`, `/wrangler.toml`, `/schema.sql`, `/README.md` are downloadable. No secrets in them (gitleaks clean), but it shows the backend's source and config, and making the repo private does **not** close it. | Production step 6 in `docs/launch-v1.md`: set the build to `cd portal && npm ci && npm run build`, output `portal/dist` (or deploy `portal/dist` with wrangler and switch Git builds off). Until then, nothing else in `main` should be added that is not meant to be public. |

## Table: item → where → test → result

### 1. Other people's data (IDOR)

| Where | Attack | Test | Result |
|---|---|---|---|
| `GET /api/orders/:id` (`orders.js`: order must belong to the session's Shopify customer; cache key per user) | A opens B's order id; a cached order served to another user | `s5_orders` S5-4, S5-11 | 404 ✓ |
| `DELETE /api/sessions/:id` | A signs out B's session with B's id | `s11` "A cannot sign out B's session…", `s9` S9-9 | 404, B still signed in ✓ (F1) |
| `DELETE /api/passkeys/:id` | A removes B's passkey | `s4` S4-15 | 404 ✓ |
| `/api/wishlist`, `/api/holds` | A lists / removes B's pieces | `s11` "Saved and Held lists are per person…", `s7` S7-5 | own rows only ✓ |
| `GET /api/gift-cards` | another customer's cards | `s6` S6-2 (session's customer only, last 4 only) | ✓ |
| `GET /api/account/export` | export contains someone else | `s9` S9-10 | own data only ✓ |
| email change confirm | token for another account | `s9` S9-5…7 | bound to its account, 1 h, one use ✓ |
| `/admin`, `/api/admin/*` | no Access JWT; JWT for another email; forged/expired/other key; `alg:none` | `s10_access` (16 tests); staging live: 403 | 403 ✓ |
| legacy `/api/user*` (token from the magic link) | someone else's subscription | `regression` M-13, A-6 | 401 for a bad token; token = own record ✓ |

Addresses and credits have no V1 endpoint (addresses live in Shopify; credits are V2).

### 2. Business logic and money

| Where | Attack | Test | Result |
|---|---|---|---|
| `POST /api/wishlist`, `POST /api/holds` | send `user_id`, `price_cents`, `product_gid`, `status`, `kind`, `source` | `s11` "client cannot write for someone else or set price/status" | ignored: own user, product from Shopify, status `open`, no price column at all ✓ |
| `PATCH /api/me` | set `tier`, `email`, `shopify_customer_id`, `deleted_at`, `id` | `s11` "client cannot change tier, email…" | 400, nothing changes ✓ |
| all JSON bodies | arrays, wrong types, 81-char names, 70 KB body, bad handles, 600-char cursor | `s11` "bad shapes and sizes are refused" | 400 / 413 ✓ |
| holds, Saved, waitlist | 4 simultaneous identical requests | `s11` race test; `s8` (tag once) | one row ✓ |
| paid / refund / credits (legacy Stripe webhook) | forged signature, replay, 20–50 concurrent deliveries, skip-vs-cancel race | `pass5`/`pass6`/`atomicity`: C-1, M-5, AC-1, AC-2, H-5a, AC-3 | 400 / credited exactly once ✓ |
| Shopify `orders/create` | forged HMAC, tampered body, redelivery, same order twice | `s10_shopify_webhook` (16) | 401 / processed once ✓ |
| gift cards | spend | no endpoint in V1 (read-only, last 4 digits) | — |

V1 takes no money and no amounts from the client. V2's credits ledger
(spec §7, §13.1: append-only, balance check and spend in one D1 transaction,
idempotency keys) is where the next race tests belong.

### 3. Brute force and enumeration

| Where | Limit | Test | Result |
|---|---|---|---|
| `POST /api/auth/magic-link` | Turnstile (fails closed); 3 / 10 min and 10 / day per email; 20 / h per IP | `s2` S2-5…S2-8 | 429 ✓ |
| `POST /api/auth/verify` | 10 / min per IP — even a valid token is refused after that | `s11` "guessing sign-in tokens", `s2` S2-15 | 429 ✓ |
| sign-in token | 256 bits, one use, 15 min, stored hashed, sent in the `#fragment` | `s11` "sign-in tokens are 256-bit, single-use…", `s2` S2-2, S2-11…S2-14 | ✓ |
| known vs unknown email | identical status and body | `s11`, `s2` S2-1 | ✓ |
| step-up code | 6 digits, 10 min, 5 tries, codes per hour | `s4` | burned after 5 ✓ |
| passkey sign-in options | 30 / min per IP | `s11` | 429 ✓ |
| email change | 3 / h per account; confirm limited per IP | `s9` | 429 ✓ |
| `POST /api/events` | 300 / h per member | `s10_events` | 429 ✓ |

Known and accepted: changing email to an address that already has an account
answers `email_taken` (spec copy). It needs a signed-in, stepped-up session and
is limited to 3 an hour, so it is not a usable enumeration oracle.

### 4. SSRF / open redirect

| Where | Result |
|---|---|
| every outbound request in `src/` (`fetch` inventory) | fixed hosts only: Resend, Turnstile, Shopify (`SHOPIFY_SHOP` var), Access certs (`ACCESS_TEAM_DOMAIN` var). **No URL from a user is ever fetched.** Legacy `worker.js`: Stripe, Resend, Gemini — fixed hosts |
| `return_to` after sign-in | `s11` "return_to only accepts a path…" and `s2` S2-8: `//evil.com`, `/\evil.com`, `https://springrenaissance.store@evil.com`, `…store.evil.com`, `javascript:`, `data:`, `http://` → dropped ✓ |
| Shopify theme upload by URL | used raw GitHub URLs pinned to a commit, MD5 checked after upload |

### 5. Open data and secrets

| Check | Result |
|---|---|
| D1 / KV reachable from outside | no: bindings only; no route returns raw tables; admin behind Access + JWT check |
| gitleaks 8.30.1 (checksum verified) on **all history, all branches** (82 commits) | 1 hit, **false positive**: a comment in the old `claude/audit-…` branch describing the PEM format (`-----BEGIN PRIVATE KEY-----\n<base64>…`), no key material |
| gitleaks on the working tree and the built bundles (`portal/dist`, `dist-staging`, `dist-e2e`, `public/admin`) | no leaks; 0 key-shaped strings (Stripe/Resend/Shopify/AWS/Google/GitHub patterns) in history or bundles |
| emails in history | only test addresses (`@b.com`, `example.*`) and the brand's own (`concierge@`, `studio@`, `pw@`); commit authors use GitHub noreply addresses. No customer emails |
| CORS | exactly `club.` and the storefront (the storefront's Save button needs it, spec §10.6), credentials, never `*` — `s1`; live on staging: only `club-staging.` |
| response fields | `s11` "no response to A carries B's email, any session hash, or internal ids" over 9 GET routes ✓ (F1); `/api/me` has no Shopify/Stripe ids |
| errors | `s11`: no stack traces or SQL in error bodies ✓ |
| **production `club.`** | **P1 above** |

### 6. Session and CSRF

| Check | Test | Result |
|---|---|---|
| cookie `__Host-sr_session`: HttpOnly, Secure, SameSite=Lax, Path=/ | `s2`, WebKit e2e | ✓ |
| new session on every sign-in; a planted cookie is never adopted | `s11` "session fixation" | ✓ |
| sign-out ends the session server-side | `s11`, `s2` S2-21 | old cookie → 401 ✓ |
| CSRF: foreign Origin, no Origin, `Origin: null`, missing `X-SR-Client` on PATCH /api/me, DELETE /api/sessions, DELETE /api/account, POST email-change | `s11` CSRF test, `s2` S2-22/S2-23, `s1` | 403, nothing changes ✓ |
| step-up before sensitive actions (passkey removal, export, deletion, email change) | `s4`, `s9` | ✓ |

### 7. Injection and XSS

| Check | Result |
|---|---|
| D1 queries | all values bound; the only interpolations are constants (column lists, a retention sub-query, the admin's WHERE built from fixed fragments) — reviewed by grep; `s11` SQL-looking name stored as text, `s10` admin search with `%` |
| names in the portal (Home greeting, Account form) | `xss.spec.ts`: `<img onerror>` payload shown as text, never runs (Chromium + WebKit) ✓ |
| names in the admin | same payload through the real Worker → Members and detail show text ✓ (`textContent` only) |
| emails | every value through `esc()`; no template prints a name |
| CSP | portal: meta, `default-src 'self'`, no inline script; admin: header, `default-src 'none'`, `frame-ancestors 'none'`; API: `default-src 'none'` |

## Protections beyond the spec (added during the build)

- Rate limiter **fails closed** (D1 hiccup → 503, not unlimited); Turnstile fails closed.
- Session ids sent to the client are opaque (F1).
- Sign-in token in the URL `#fragment` (never in server logs; mail scanners cannot spend it).
- Body size caps: 64 KB JSON, 2 KB events, 1 MB webhooks.
- API security headers on every response: `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `CSP default-src 'none'`.
- Admin: Worker-side JWT check even behind Access, audit of member views, strict CSP, `X-Frame-Options: DENY`.
- Event allowlist with fixed properties; server events cannot be forged.
- Webhook errors and logs never carry payload or personal data.
- Retention cron (§13.2): sessions 30 days after ending, links/challenges/codes after a day, events after 13 months.
- Email change: notice to the old address at request time.
- Staging cannot touch the live store (Shopify off on staging).

## Recommended next (not done)

1. **P1** — close the repo-root exposure on `club.` (production step 6).
2. Make the repository private (below).
3. HSTS for `api.` and `club.` (Cloudflare → SSL/TLS → Edge Certificates; a zone setting, so Felix's yes).
4. A Cloudflare WAF rate-limiting rule on `/api/auth/*` as an outer layer to the Worker's limits.
5. gitleaks in CI on every PR (added in this pass: `.github/workflows/secrets.yml`).

## Making the repository private — what changes

Checked 16 Oct: 0 forks; the repo's GitHub Pages has `CNAME club.springrenaissance.store`
but DNS for `club.` points to Cloudflare Pages, so GitHub Pages serves nothing there.

| Thing | After "private" | Action |
|---|---|---|
| Cloudflare Pages `spring-renaissance-club` (Git-connected to this repo) | keeps building if the Cloudflare Pages GitHub App can see the repo (it is installed and connected today) | after the switch: GitHub → Settings → Applications → Cloudflare Pages → repository access includes this repo; retry the last deployment once |
| GitHub Pages of this repo | switched off (Free plan) | no effect on `club.` (served by Cloudflare); remove `CNAME` from `main` to avoid confusion |
| GitHub Actions (worker-ci, portal-ci, secrets) | private repos use the 2,000 free minutes a month; a full e2e run is ~10 min | CI runs only on PRs and by hand — enough |
| `raw.githubusercontent.com` links | 404 | only used for today's theme uploads (done); later uploads send the file inline |
| other sites (Concierge, Registry, Support) | live in other repos (`concierge.`, `registry.`, `reserve.`) | not affected |
| what was public | already copied by anyone who looked | nothing secret was found in any commit, so nothing to rotate |

Steps (Felix, GitHub settings): Settings → General → Danger Zone → Change
visibility → Private → confirm. Then: check the Cloudflare Pages app access,
retry one Pages deployment, open a PR to see CI run.
