# V2 Circle — API reference (as built)

All member endpoints: session cookie; writes need `Origin` = portal and
`X-SR-Client: portal`. Admin endpoints: Cloudflare Access JWT; writes need
`Origin` = the API origin and `X-SR-Client: admin`. Errors:
`{ error: { code, message }, explanation? }`. Money in cents; dates ISO
(`YYYY-MM-DD` where a day is meant). Source of truth: `src/app.js` ROUTES.

## Member

| Method | Path | Answer |
|---|---|---|
| GET | `/api/circle` | `{ membership: null }` for Club; for members `{ membership: { status, kind, since, current_period_end, ends_on, end_reason, credits_grace_until, paid_months }, balance_cents, next_accrual: {date, amount_cents}\|null, expires_on, frozen, welcome: {status}\|null, anniversary?: {status} }` |
| GET | `/api/circle/join[?invite=CODE]` | `{ kind: join\|rejoin\|member, open, reason (not_open, not_configured, welcome_set_incomplete, price_mismatch, already_member), terms_version, terms_url, consents: [{id: terms\|age_18, text}], region_note, first_charge_cents, monthly_cents, joining_cents, discount_cents, first_renewal_on, disclosure, invitation_note }` |
| POST | `/api/circle/checkout` | body `{ consents: {terms:true, age_18:true}, terms_version, invite_code? }` → 201 `{ url }` (Stripe Checkout). 400 consent_required, 409 terms_changed / already_member / use_rejoin / circle_not_open, 503 payment_unavailable |
| POST | `/api/circle/rejoin` | same body → 201 `{ url }`; 409 not_a_former_member / already_member |
| GET | `/api/circle/credits[?cursor=]` | `{ balance_cents, next_accrual, expires_on, frozen, ledger: [{date, memo, amount_cents, kind, running_balance_cents}], next_cursor }`; 403 not_a_member |
| POST | `/api/credits/redeem` | header `Idempotency-Key`, body `{ amount_cents }` (whole credits) → 201 `{ redemption: {id, amount_cents, code, last4, status} }` (code shown once); repeat key → 200 `{ redemption: {..., code:null}, repeated:true }`; 403 step_up_required; 409 insufficient_credits / credits_frozen / balance_negative / credits_expired; 503 credits_unavailable |
| GET | `/api/credits/redemptions` | `{ redemptions: [{id, amount_cents, last4, status, purpose, created_at}] }` |
| POST | `/api/credits/redemptions/:id/return` | → `{ returned:true, balance_cents }`; 409 card_used / not_returnable |
| GET/POST | `/api/circle/welcome` | GET `{ status, options:[{id,title,blurb,image_url}] }` (options only while awaiting_choice); POST `{ gift_option_id }` → `{ status:'chosen' }`; 409 already_chosen / option_unavailable |
| POST | `/api/circle/cancel/start` | `{ reason: spending_less\|not_finding_pieces\|too_many_credits\|order_issue\|plans_changed\|other, comment? }` → 201 `{ cancellation_id, offer: {kind: concierge\|use_credits\|concierge_priority, copy}\|null, ends_on, credits_until, balance_cents }` |
| POST | `/api/circle/cancel/confirm` | `{ cancellation_id }` → `{ ends_on, credits_until }` |
| POST | `/api/circle/cancel/keep` | `{ cancellation_id, offer_accepted? }` → `{ kept:true }` |
| POST | `/api/circle/cancel/undo` | → `{ status:'active' }`; 409 not_canceling |
| POST | `/api/circle/billing/retry` | "I've updated my card" → `{ result: paid\|pending\|declined\|nothing_to_pay }` |
| GET | `/api/account/membership` | `{ status, kind, since, monthly_cents, current_period_end, ends_on, credits_grace_until, next_charge: {date, amount_cents}\|null, invoices: [{date, amount_paid_cents, status, url}] }` |
| POST | `/api/account/membership/portal` | → `{ url }` (Stripe Customer Portal: card and invoices) |
| GET | `/api/circle/object` | `{ release: {id, title\|null, description, image_url, price_cents, closes_at, sold_out, one_per_member, remaining?}\|null, claim: {status, reserved_until, invoice_url}\|null, can_claim, reason (no_release, members_only, already_claimed, paused, sold_out) }` |
| POST | `/api/circle/object/claim` | `{ release_id }` → 201 `{ status:'invoiced', invoice_url, reserved_until }` (200 with the same for a second tab); 403 members_only; 409 sold_out / release_closed / release_paused |
| GET | `/api/circle/invite` | `{ code, link, discount_cents, reward_cents, season, this_season: none\|joined\|counted, paused }`; 403 members_only |
| GET/POST | `/api/circle/anniversary` | GET `{ gift: {id, n, status, address, name}\|null }`; POST `{ address: {name, line1, line2?, city, state, postal_code, country:'US'} }` → `{ status:'ready' }` |
| GET | `/api/circle/capsules` | `{ current: {id, season, title, price_cents, opens_at, closes_at, skipped, claimed, product_url, eligible, reason}\|null, upcoming: [...] }` |
| POST | `/api/circle/capsules/:id/claim` | step-up within 15 min (403 step_up_required) → 201 `{ capsule_id, amount_cents, code, last4?, product_url }` |
| GET/POST/DELETE | `/api/circle/skips[/:capsule_id]` | list / `{ capsule_id }` / undo — before the window opens only (409 capsule_window_open) |
| GET/POST | `/api/circle/concierge` | GET `{ messages:[{id, author: member\|maison, body, created_at}], unread }`; POST `{ body, priority? }` → 201 |
| GET/PUT | `/api/circle/rooms` | GET `{ photos:[{id, room_label, note, created_at}] }`; PUT raw image (`Content-Type` image/jpeg\|png\|webp, `?label=`) → 201; 503 rooms_unavailable without R2 |
| GET/DELETE | `/api/circle/rooms/:id[/image]` | the image (owner only) / delete |
| GET | `/api/storefront/circle-price?product=<handle>` | public, cached 5 min: `{ variants: { "<numeric id>": {price_cents, circle_price_cents} } }` |
| GET | `/api/me/storefront` | `{ is_member }` |

## Admin

| Method | Path | What |
|---|---|---|
| GET/PUT | `/api/admin/economics` | snapshot (settings, profiles expected/worst, cost_per_credit_ppm, referral check, anniversary budget, circle_price excluded list, needs_data, estimates) / `{ changes }` → saved or 422 `economics_rule_failed` with `explanation` |
| GET/PUT | `/api/admin/costs` | catalog variants with cost, class, list flag, eligibility, reason, max cost / `{ variant_gid, cost_cents\|null, zero_confirmed?, shipping_class }` |
| PUT | `/api/admin/circle-price/list` | `{ variant_gid\|product_gid, on_list }` |
| POST | `/api/admin/catalog/sync` | reads the Shopify catalog (query only) |
| GET / POST | `/api/admin/circle-price/status` / `.../sync` | discount shards, members with the price; run the sync now (409 sync_off) |
| GET/POST/PATCH | `/api/admin/gift-options[/:id]` | welcome / anniversary pools (`within_cap`, `within_budget`) |
| GET | `/api/admin/gift-queue` | `{ welcome:[...], anniversary:[...] }` |
| POST | `/api/admin/gift-queue/:id/assign` / `.../create-order` | welcome: assign after 14 days / create the $0 Shopify order |
| POST | `/api/admin/anniversary/:id/assign` / `.../create-order` | anniversary gift |
| GET/POST/PATCH | `/api/admin/member-object/releases[/:id]` | releases with `min_price_cents`, `claims` counts |
| POST | `/api/admin/member-object/releases/:id/open` / `.../close` | open (422 release_incomplete / price_below_minimum / guard_failed) / close |
| GET | `/api/admin/member-object/guard?release=` | the live guard result |
| GET / PATCH | `/api/admin/invitations` / `/:id` | list + review queue / `{ decision: credit\|reject }` |
| GET/POST/PATCH | `/api/admin/capsules[/:id]` | capsules |
| GET / GET / POST | `/api/admin/concierge` / `/:id` / `/:id/reply` | threads, a thread with room photos, reply |
| GET | `/api/admin/rooms/:id/image` | a member's room photo |
| POST | `/api/admin/credits/adjust` | `{ user_id, amount_cents, memo }` (note required; optional `Idempotency-Key`) |
| POST | `/api/admin/members/:id/unfreeze` | `{ memo }` — lift a dispute freeze (note required, audited) |
| GET | `/api/admin/circle/overview` | members by status, credits outstanding, monthly recurring, open flags, queues |
| GET / POST | `/api/admin/flags[?status=resolved]` / `/:id/resolve` | signals for Felix |
| GET | `/api/admin/members[?status=]`, `/api/admin/members/:id` | V1 + membership, balance, next charge, ledger, invoices |

## Webhooks
`POST /webhooks/stripe` (STRIPE_CIRCLE_WEBHOOK_SECRET) and `POST /webhooks/shopify`
(orders/create audit, draft_orders/update → object claim paid, products/update → catalog re-read within 5 minutes).
