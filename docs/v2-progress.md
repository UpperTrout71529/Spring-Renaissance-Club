# V2 Circle — progress log

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
| T3 Ledger & credits | todo | |
| T4 Spend credits | todo | |
| T9 Failed payments | todo | |
| T11 Cancel, grace, rejoin | todo | |
| T12 Refunds, disputes, delete | todo | |
| T7 Welcome piece | todo | |
| T6 Member price (C) | todo | |
| T8 Emails & cron | todo | |
| T15 Members' object (B) | todo | |
| T16 Anniversary (G) | todo | |
| T17 Invite a friend (H) | todo | |
| T10 Skip | todo | |
| T13 Capsules | todo | |
| T14 Concierge & rooms | todo | |
| T18 Admin v2 | todo | |
| Portal screens | todo | |
| T19 Benefits copy & storefront | todo | |
| Staging deploy | todo | |
| T21 Early access (pre-order) | todo | last |
| Report | todo | docs/v2-report.md + vault copy |

## Log

- 16 Oct: T0, T5 (engine + D1 + admin API), T1 (join/rejoin API), T2 (webhook state machine) done; suite 434/434.
  Test helpers for V2: test/v2-helpers.mjs (Shopify ops by name, Stripe fake, admin client, event fixtures).
