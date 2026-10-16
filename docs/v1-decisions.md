# LK V1 — decisions, copy for review, open questions

Running list for PR review (Felix). Spec: "ЛК — ТЗ v1.1" (2026-10-15).
"My call" = not defined in the spec, decided during the build.

## Open questions for Felix

1. **Shopify access (P0.4).** Token mechanism for "Claude Sync" still TODO
   (Felix sets the scopes and the token). Scopes the code needs now:
   `read_customers`, `write_customers`, `read_orders`, `read_all_orders`
   (orders older than 60 days), `read_products` (pre-order rule), and the
   fulfillment-order reads Shopify's validator lists for `Order.fulfillments`:
   `read_assigned_fulfillment_orders`, `read_merchant_managed_fulfillment_orders`,
   `read_third_party_fulfillment_orders`, `read_marketplace_fulfillment_orders`.
2. **Draft theme lags the live theme.** `snippets/sr-preorder` in the draft
   WORK 4 (189096820957, last changed 7 Oct) lacks the 13 Oct catalog
   exclusion that the live theme (189304766685) has. The API follows the
   newer, live version. Worth syncing the draft before the next theme edit.

## Answered (16 Oct 2026)

- **Pre-order rule (S5):** same as the theme's `sr-preorder`: a product in at
  least one collection, not in `snowfall` / `catalog` / `ember`, not tagged
  `catalog`, not `patron-membership`, `sr_run.hide` not true. A pre-order
  selling plan (the spec's rule) still counts. One function:
  `isPreorderProduct`, `src/shopify/orders.js`.
- **Dates and money:** always `en-US` ("Oct 2, 2026", "$1,234.50"), not the
  browser's language (`portal/src/format.ts`).
- **`club.springrenaissance.store` is served by Cloudflare Pages** (CNAME to
  `spring-renaissance-club.pages.dev`), not GitHub Pages. S11 plans the portal
  deploy through that Pages project (build `portal/`, output `portal/dist`,
  `VITE_*` variables set there too); `.github/workflows/pages.yml` is not the
  production path. Cloudflare Pages can also send the CSP as a real header
  (`_headers`) — to decide in S11.
- **D1 Time Travel:** 7 days (Free plan). Rollback by bookmark must happen
  within a week of the rollout.
- **SPF:** one record at the root, one on `send.` — correct as is.
- Done by Felix: Turnstile widget (Invisible, club.), Web Analytics, GitHub
  `VITE_*` variables, Cloudflare Pages branch previews off.

## Decisions (my calls)

### S1 — API foundation
- Migrations in shipping order: ops is `0003` (spec: `0004`), S4 challenges
  `0004`, V2 membership will be `0005`.
- `users` (pre-portal subscribers) renamed to `legacy_users`; the spec's `users`
  is new. Rollout must ship migrations and Worker together
  (`docs/rollout-s1.md`).
- `GET /api/me` implemented in S1 (needed to test 401).
- `processed_events` kept next to `webhook_events` until T2.
- Plain JS + `node --test`, as the repo was.

### S2 — sign-in by link
- Malformed email → 400 `invalid_email`; Turnstile failure → 400
  `turnstile_failed`; rate limit → 429. None of these reveal whether an email
  has an account.
- Turnstile and the rate limiter fail closed: no check, no email.
- Shopify API version defaults to `2026-07` (latest stable on shopify.dev).

### S3 — portal shell
- `--ink-muted #5C5B58`, `--danger #8E3B30`, `--success #3D5A3A` (not in the
  theme; ≥ 4.5:1 on `#FBFBF9`). *Accepted.*
- Tablet (768–1023 px) uses the tab bar. *Accepted.*
- Circle tab icon: Lucide "Stamp". *Accepted.*
- One `.html` per static route so GitHub Pages answers 200, not 404.
- Pages deploy is manual only; CI on PRs and manual runs.

### S4 — passkeys and step-up
- New tables `webauthn_challenges`, `step_up_codes` (migration 0004).
- New endpoints beyond §8.2: `POST /api/auth/step-up/passkey/options`
  (needed for step-up with a passkey), `GET /api/passkeys` (list for the
  security screen).
- `email` in `POST /api/auth/passkey/login/options` is accepted and ignored,
  so the options never reveal which addresses have passkeys.
- Public keys stored as base64url text in the `public_key` column.
- Step-up email codes: at most 5 per user per hour (spec sets 10 minutes and
  5 attempts per code, not a send limit).
- Account screen got "Sign out" (on mobile there is no sidebar).

### S5 — orders
- `status` added to the order payload (`processing` / `preorder` / `shipped`
  / `delivered` / `refunded`), derived from Shopify's statuses; raw
  `financial_status` / `fulfillment_status` are kept.
- `:id` is the numeric part of the Shopify order gid.
- A fulfillment with several tracking numbers becomes one entry per number;
  cancelled fulfillments are left out. `shipped_at` = in-transit time, else
  the fulfillment's creation time.
- A missing Shopify customer link → empty list (not an error); Shopify down →
  503 `orders_unavailable`.
- `SHOPIFY_SHOP` lives in `wrangler.toml` `[vars]` (not a secret).

## Copy for review (not quoted in the spec)

### Step-up dialog
- Title: "Confirm it's you"
- Body: "For your security, please confirm before making this change."
- Buttons: "Confirm with Face ID" / "Confirm with Touch ID" / "Confirm with
  your device"; "Email me a code"; "Cancel"
- After sending: "We sent a 6-digit code to {email}. It works for 10 minutes."
- Field label: "Confirmation code"; buttons "Confirm", "Send a new code"
- Passkey failed: "We couldn't confirm with this passkey. You can use a code instead."
- API errors shown in the dialog:
  - "That code isn't right. Please check it and try again."
  - "This code has expired. We can send you a new one."
  - "Too many attempts. We can send you a new code."
  - "Please confirm it's you to continue." (403 `step_up_required`)

### Step-up email (`step_up_code`)
- Subject: "Your confirmation code"
- "Your Spring Renaissance confirmation code is {code}."
- "It works for 10 minutes. If you didn't ask for it, you can ignore this
  email — your account stays as it is."

### Sign-in & security screen
- Title: "Sign-in & security"; section "Passkeys"
- Intro: "Sign in with your face, fingerprint or screen lock instead of an email link."
- Empty: "No passkeys yet" / "Sign in faster next time with {Face ID | Touch ID | a passkey}."
- Add button: "Add Face ID" / "Add Touch ID" / "Add a passkey"; while waiting:
  "Waiting for your device…"
- Row: "{device label}" (or "Passkey"), "Added {date} · Last used {date}" /
  "Not used yet"; "Remove" (screen readers: "Remove {label}")
- Errors: "We couldn't add this passkey. Please try again."; "You can keep up
  to 10 passkeys. Remove one to add another."; "This passkey is already saved."

### Sign-in screen additions
- "or" divider; "Sign in with Face ID" / "Sign in with Touch ID" / "Sign in
  with your device" (the spec's labels)
- "We couldn't sign you in with this passkey. Try again, or use a sign-in link."

### Account screen
- "Sign-in & security", "Sign out"

### Orders (spec copy used verbatim: "No orders yet", the empty-state body and
"Explore the collections", status labels Processing / Pre-order · in
production / Shipped / Delivered / Refunded, "Load more", "Track with
{Carrier}", "Need help with this order?", "We'll email you when it ships.")
- Card: "+{n}" more items (spec: "+N")
- Detail: back link "Orders" (screen readers: "Back to orders"); "Placed
  {date}"; sections "Items" and "Shipments"; "Qty {n}"; "Total"; "Shipping to
  {city}"; "Tracking number {n}"; "Shipped {date}"; "Delivered {date}";
  "Arrives {date}" (only when Shopify has an estimate); "Track parcel" when the
  carrier is unknown; "Pre-order" tag on a line
- 404: "Order not found" / "This order isn't on your account. Orders placed
  with a different email won't show here."
- 503: "We couldn't load your orders right now. Please try again in a moment."
