| T8 Emails & cron | done | ea585cd || T6 Member price (C) | done (behind CIRCLE_PRICE_SYNC; theme snippet in T19) | d7dd944 || T7 Welcome piece | done (API + admin API) | 6b9b78b || T12 Refunds, disputes, delete | done | 8fcb1d7, 30f4f26 || T11 Cancel, grace, rejoin | done (API) | 30f4f26 || T9 Failed payments | done (webhook + retry button) | 8fcb1d7, 30f4f26 || T4 Spend credits | done (API) | de7686a || T3 Ledger & credits | done (API) | de7686a |# V2 Circle — progress log

Read this first after a context reset. Spec: `docs/tz-v2-circle.md`;
decisions: `docs/v2-decisions.md`; blockers: `docs/v2-blockers.md`.
Branch `v2-circle` (from `feat/lk-v1` @ c725e17). Never merge into `main`.

Rules (Felix, 16 Oct): autonomous, no questions; TDD, small commits, push
after each task when green; deploy only to api-staging / club-staging; Stripe
test mode only; Shopify only draft theme 189482795229, nothing in the live
store (products, discounts, draft orders, customers); no secrets typed or
printed; nothing deleted (legacy VIP off by flag); no purchases.

## Order of work

| Task | Status | Notes |
|---|---|---|
| T0 Foundations | done | 1ef0ee7 |
| T5 Economics engine | done (API); admin screen in T18 | cef0c9c, dbab5db |
| T1 Join | done (API); portal screen later | 42ac438 |
| T2 Stripe webhooks & state | done (incl. T9/T11/T12 webhook side); daily Stripe reconcile with T8 cron | 8fcb1d7 |
| T3 Ledger & credits | done (API) | de7686a |
| T4 Spend credits | done (API) | de7686a |
| T9 Failed payments | done (webhook + retry button) | 8fcb1d7, 30f4f26 |
| T11 Cancel, grace, rejoin | done (API) | 30f4f26 |
| T12 Refunds, disputes, delete | done | 8fcb1d7, 30f4f26 |
| T7 Welcome piece | done (API + admin API) | 6b9b78b |
| T6 Member price (C) | done (behind CIRCLE_PRICE_SYNC; theme snippet in T19) | d7dd944 |
| T8 Emails & cron | done | ea585cd |
| T15 Members' object (B) | done (API + admin API) | 321c189 |
| T16 Anniversary (G) | done | 759ae22 |
| T17 Invite a friend (H) | done | 9ca75f1 |
| T10 Skip | done | 6884ffe |
| T13 Capsules | done | 6884ffe |
| T14 Concierge & rooms | done (rooms need R2, B6) | 5cea18d |
| T18 Admin v2 | done (API 2278128, screens c056823) |
| Portal screens | done (5cad22f) |
| T19 Benefits copy & storefront | done (theme files a8c145e, copy in the portal) |
| Staging deploy | done: Worker f5cf0ba0, D1 0006–0012, Pages club-staging; smoke ok |
| T21 Early access (pre-order) | done (API) | c86a254 |
| Report | done | docs/v2-report.md + vault «ЛК — V2 отчёт.md» |

## Log

- 16 Oct: T0, T5 (engine + D1 + admin API), T1 (join/rejoin API), T2 (webhook state machine) done; suite 434/434.
  Test helpers for V2: test/v2-helpers.mjs (Shopify ops by name, Stripe fake, admin client, event fixtures).
- 16 Oct (later): T3, T4, T11, T9, T12, T7, T8, T6 done; suite 486/486. Next: T15 object, T16 anniversary, T17 invite, T10/T13/T14, admin UI, portal UI, theme, staging, T21.
- 16 Oct (evening): T15, T16, T17, T13/T10, T14, T18 API, T21, theme files, Stripe setup script; staging Worker deployed with migrations 0006–0011; suite 542/542.
  Two background agents: portal Circle screens (portal/) and admin screens (public/admin/) — they do not commit; review their files, run portal unit + e2e and the admin e2e config (port 4444), then commit.
  A read-only backend review agent is running; fix its confirmed findings with tests.
  Left: integrate UI work, deploy club-staging (portal build:staging → Pages project spring-renaissance-club-staging), staging smoke, report (docs/v2-report.md + vault copy).
- 16 Oct (night): independent backend review → 13 findings fixed with regression tests (07b569f, D40); migration 0012 on staging; suite 556/556. Waiting for the portal and admin UI agents (both told about: early access API, capsule step-up, object 'creating' status, admin unfreeze, adjust Idempotency-Key).
- 17 Oct: admin screens (44/44 e2e) and portal screens (380/380 e2e) committed; 11 more gaps from the UI build fixed (D41–D42); worker suite 565/565; club-staging + api-staging deployed, smoke ok; report written. V2 build complete — next steps are Felix's (docs/v2-blockers.md, docs/rollout-v2.md).
- 17 Oct (Felix's follow-up): Stripe test setup is one command with a hidden key prompt and a permission check (b80d896, suite 576/576). Draft-theme templates/product.json V2 copy prepared in theme/pending/product-json-v2 (67 edits + 2 lines, Patron Notes disabled; expected stored md5 73a92767…); review note in the vault «ЛК — V2 тексты product.json.md». Not uploaded — waits for Felix's «да».
- 17 Oct (later): Felix approved the product.json copy with two changes (Circle price "applied at checkout while your membership is active"; The Atelier Vignette live). Uploaded to the draft theme only from 9b5cd15; file md5 in the theme 17e34431… = the committed file byte for byte. Live theme unchanged.
- 17 Oct (later): by Felix's request: draft-theme templates/product.le-vase-livre.json replaced with the same V2 file (was an exact copy of product.json; md5 now 17e34431…); live product Patron Membership (patron-membership) UNLISTED → DRAFT (not deleted or archived; 0 orders in the store via API). Live theme unchanged.
