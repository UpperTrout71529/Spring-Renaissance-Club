# LK V1 — decisions, copy for review, open questions

Running list for PR review (Felix). Spec: "ЛК — ТЗ v1.1" (2026-10-15).
"My call" = not defined in the spec, decided during the build.

## Open questions for Felix

1. **Shopify access (P0.4) — code done, secrets pending.** "Claude Sync"
   (Dev Dashboard app, version claude-sync-2) has no permanent token; the
   Worker now gets a 24-hour token by the client credentials grant and
   refreshes it (`src/shopify/admin.js`). Felix puts `SHOPIFY_CLIENT_ID` and
   `SHOPIFY_CLIENT_SECRET` with `wrangler secret put`. Granted scopes (16 Oct):
   read/write_customers, read_orders, read_all_orders, read_assigned /
   merchant_managed / third_party_fulfillment_orders, read_fulfillments,
   read_products, read/write_gift_cards, write_draft_orders,
   read/write_discounts. `read_marketplace_fulfillment_orders` does not exist
   as a grantable scope (Shopify refused it); the validator lists the
   fulfillment-order scopes as alternatives, so the granted ones cover
   `Order.fulfillments`. To confirm with the first real call once the
   secrets are in.
2. **Circle FAQ on /circle (S8) — please read.** §6.6 asks for five answers.
   They restate the spec's decisions (credits $1 each, store credit only;
   Skip = skip a season's capsule, billing and credits continue, no refund;
   cancel online any time, effective at the end of the paid month; credits
   usable 30 days after the last paid month; 25% on the collections, not
   Small Pleasures, gift cards or capsules). These are membership terms the
   lawyer has not reviewed yet (P0.7). **PENDING LEGAL REVIEW — not for
   production** (Felix, 16 Oct): the FAQ lives in `portal/src/copy/circle-faq.ts`
   and renders only when the build sets `VITE_CIRCLE_FAQ=1` (the e2e build
   does; production does not, and portal-ci fails if the strings reach a
   production bundle). The Membership Terms link from §6.6 is left out: the
   terms page does not exist in V1.

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

### S6 — Home and gift cards
- `GET /api/me` adds `user.created_at` and `onboarding.dismissed`;
  `PATCH /api/me` accepts only `{ onboarding_dismissed: true }` for now.
- Gift cards bought for someone else (recipient set to another customer) are
  not counted in the buyer's balance; disabled cards are left out.
- The gift card row is hidden unless there is a card with a balance; it
  expands to the cards (last 4 only).
- "Make it yours" sits after the order and gift card blocks (usefulness
  first); greeting splits the day at 5, 12 and 18.
- A date without a time (gift card expiry) is formatted in UTC so it never
  shows a day early.

### S7 — Saved and Held for you
- Extra endpoints: `GET /api/wishlist/handles` (cheap, D1 only, for the
  storefront hearts) and `POST /api/holds` (spec §9.2.7 mentions it, §8.3
  does not list it).
- "No longer available" = product not active, not on the online store, or no
  variant for sale (archived / unpublished / sold out / deleted).
- Import of "Let us hold these for you": the form keeps the pieces only as
  customer tags `reserve-<handle>[-<variant>]` (live theme,
  `sections/sr-reserve-intercept.liquid`, currently `hold_mode` off). They
  become holds at each sign-in, once per piece. Quantities are not in
  Shopify, so they are not imported.
- The storefront heart is on product pages only (not on collection cards);
  signed out, it sends the visitor to sign in and back with `?sr_save=1`,
  which saves the piece on arrival.
- The reservation form itself does not post to `/api/holds` yet: it is
  switched off in the live theme.
- Theme (with Felix's yes, 16 Oct): in the draft "Spring Renaissance Latest
  Version - Draft" (189482795229) — new `snippets/sr-save.liquid`, and two
  lines appended to `snippets/sr-touch-fix.liquid` (a comment and
  `{% render 'sr-save' %}`). Nothing else touched (no templates, no
  sr-consult). Backup and checksums: `theme/backups/`.

### S8 — Circle teaser and waitlist (V1)
- No Welcome piece count in V1: `gift_options` is a V2 table, so
  `sealed_count` is 0 and the copy names no number (§6.3 rule).
- Circle price line only for saved pieces that are ACTIVE, published on the
  online store and purchasable, from the main collections (not catalog /
  Small Pleasures, gift cards, capsules, the membership); member price = 75%
  of Shopify's price in cents, rounded half up; at most 3. Archived, draft
  and unpublished pieces are skipped (test S8-8). The screenshot's "Pierre
  Blanche … $66.00" was test data ($88 × 0.75); fixtures now use The Kouros
  Fragment, $220 → $165.
- "Reserve a place" creates one `circle_waitlist` hold and tags the customer
  `circle-waitlist` once (retried at the next sign-in if Shopify was down).
- "Not now" folds the teaser to one line, "The Renaissance Circle · Opening
  soon", linking to /circle, for 30 days (spec: "свёрнут до одной строки").
- The teaser is the last block on Home; the illustration is three abstract
  sealed envelopes (no count implied, no product photos).

### S9 — Account and privacy
- Migration 0005 adds `magic_links.user_id` (an email-change link must know
  whose account changes). V2 membership tables become 0006.
- Email change: the confirmation link goes to the new address and lives one
  hour (sign-in links: 15 minutes); the old address gets a notice at request
  time; at most 3 requests per hour. Confirming needs no session (the link may
  be opened on another device).
- The seasonal letter switch writes a `consents` row each time (version
  `seasonal-email-2026-10`, SHA-256 of the exact label); a worker test keeps
  the label and the hash text identical.
- Names are mirrored to the Shopify customer (`customerUpdate`); so is a
  confirmed email change.
- Sessions list shows device and city only (no IP); "Sign out everywhere
  else" keeps the current session.
- Export (step-up): profile, consents, saved, holds, passkey and session
  metadata — never keys, token hashes or other people's data.
- Delete (step-up + typed confirmation): personal rows erased, the user row
  anonymised (`deleted+<id>@invalid`), consents kept without personal data,
  every session ended, our Shopify tags (`sr-club`, `circle-waitlist`)
  removed. Shopify's own data erasure (`customerRequestDataErasure`) is **not**
  automated — it cannot be undone; Felix gets an email at
  `ADMIN_NOTIFY_EMAIL` with the Shopify customer id to decide. Needs the
  variable `ADMIN_NOTIFY_EMAIL` (Felix's work address).

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

### Home (spec copy used: "Good evening, {name}", "Welcome back", "Club member
since …", "On its way", "Track parcel", "Gift card balance", and the three
§6.10 items "Account created" / "Add Face ID for faster sign-in" / "Save a
piece you love")
- "Good morning" / "Good afternoon" (the spec shows only "Good evening")
- "View order"; "Card ending {last4}"; "Expires {date}"
- "Make it yours" progress "{n} of 3 done"; "Dismiss"; "Add Touch ID / a
  passkey for faster sign-in" on non-iPhone devices

### Saved (spec copy used: "Saved", "Held for you", "No longer available",
"Nothing saved yet", its body and "Browse the store", "We'll write when
reservations open.")
- "This piece" when Shopify no longer knows the product
- Heart button (screen readers): "Remove {title} from Saved"
- "Held since {date}"; "Order #{n} · Pre-order"
- Empty Held: "Nothing held for you" / "Pieces we hold for you and your
  pre-orders will appear here."
- Home: "Saved ({n})", "Held for you ({n})", "See all"
- Storefront button: "Save" / "Saved"

### Circle (spec copy used verbatim: "The Renaissance Circle", "A sealed
object, chosen by you.", the two body lines, "With the Circle, {Object} would
be ${price}.", "Learn about the Circle", "Opening soon", "Reserve a place",
"You're on the list. We'll write once, when the Circle opens.", "Not now", the
three steps)
- Folded line: "The Renaissance Circle · Opening soon"
- While sending: "Reserving…"; section titles "How it works", "Questions"
- Held for you: "A place in the Circle"
- FAQ answers (see open question 2):
  - What are credits? — "Each month, $20 of your membership becomes 20
    credits. One credit is $1 to spend on anything in the house. Credits are
    store credit for Spring Renaissance only."
  - What does Skip mean? — "Skip lets you pass on a season's capsule. Your
    membership and monthly credits continue as usual, and nothing is
    refunded."
  - How do I cancel? — "Online, in your account, at any time. Cancelling
    takes effect at the end of the month you have paid for."
  - What happens to my credits if I cancel? — "They stay usable for 30 days
    after the end of your last paid month, then they expire."
  - What does the 25% apply to? — "Our collections. It does not apply to
    Small Pleasures, gift cards or seasonal capsules."

### Account and privacy (spec copy used: "Delete account", "Keep my account",
"Download my data", the §13.4 deletion text adapted for Club members, "That
email already has an account…" for a taken address)
- Profile: "Profile", "First name", "Last name", "Save", "Saved.", "Delivery
  addresses are kept at checkout."
- Email: "Change email", "New email address", "Send confirmation link", "We
  sent a link to {email}. Your email changes once you confirm it.", "Cancel"
- Emails: "Emails about signing in, your orders and your account are always
  sent."; switch: "Send me the seasonal letter — one email each season. You
  can turn it off at any time." (this exact text is hashed into the consent)
- Links: "Privacy & data", "Privacy Policy" (storefront
  /policies/privacy-policy), "Contact the concierge"
- Sessions: "Active sessions", "This device", "Unknown device", "Signed in
  with an email link / a passkey", "Last active {date}", "Sign out", "Sign
  out everywhere else"
- Privacy: "Privacy & data"; download body "A JSON file with your profile,
  consents, saved pieces, holds, sign-in methods and sessions."; deletion
  (Club): "Delete account? Your saved pieces and holds are erased and you are
  signed out everywhere. Orders stay on record for tax purposes."; after
  deletion on the sign-in page: "Your account has been deleted."
- Email confirm page: "Confirming your new email…", "Your email is now
  {email}.", "Go to your account", "This link has expired" / "Email change
  links work once, for one hour. You can ask for a new one in your account."
- Emails: email_change_confirm "Confirm your new email" (button "Confirm
  email"); the notice "A change to your account email"; account_deleted "Your
  account has been deleted"; internal "Account deleted — Shopify data to
  review"

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
