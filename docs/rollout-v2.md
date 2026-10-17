# V2 Circle — rollout (staging → launch)

Every production step needs Felix's "yes". Staging steps marked (staging) are
safe to do any time. Rollback for each step at the end.

## A. Staging, end to end (test mode)

1. (staging) Stripe test mode, one PowerShell command (any folder):
   `node C:\Users\FS\Desktop\Spring-Renaissance-Club\scripts\stripe-test-setup.mjs`
   — asks for the key in a hidden prompt (a restricted `rk_test_` key with the
   permissions listed in `PERMISSION_PROBES` in the script: Write on Customers,
   Products, Checkout Sessions, Coupons, Customer portal, Invoices, Prices,
   Subscriptions, Webhook Endpoints; Read on Charges, Payment Intents), checks
   those permissions without changing anything, creates Product A/B with
   `circle_monthly_usd` / `circle_joining_usd` and the staging endpoint (API
   `2026-09-30.endive`, Circle events), then stores `STRIPE_CIRCLE_WEBHOOK_SECRET`
   and `STRIPE_SECRET_KEY` on staging through wrangler (stdin, never printed).
   Missing permissions → it names them and stops before creating anything.
2. (staging) Stripe test Dashboard: Customer Portal = update card + invoices only;
   custom retry schedule 3 retries (+3, +4, +3 days) then cancel; customer emails off.
3. (staging) Admin → Economics: shipping S/M/L (your estimates, "estimate" ticked);
   Gift pools: at least 2 welcome pieces (Small Pleasures, landed + shipping ≤ $25).
   Staging has no Shopify, so the catalog stays empty there — enough to open the join.
4. (staging) `wrangler.toml [env.staging.vars]`: `CIRCLE_JOIN_OPEN = "on"`, deploy
   (`npx wrangler deploy --env staging`).
5. (staging) Join with a Stripe test card (4242…) on club-staging → welcome email,
   20 credits, sealed-piece choice; test clock for renew / fail (card 4000 0000 0000 0341)
   / recover / cancel / end.

## B. Shopify development store (the spike, §19 #1, #7)

1. Felix creates a dev store and gives "Claude Sync"-like app access there.
2. With Felix's "yes" I run: the automatic "specific customers" discount for a buyer
   who only types the email at checkout; a gift card paying a draft invoice; a
   fixed-amount customer code stacking with the Circle price; the customers-per-
   discount limit. Outcome decides `CIRCLE_PRICE_SYNC` / shard size or the fallback
   (personal codes, see decisions).

## C. Launch (production, each step after "yes")

1. Counsel + tax advisor (P0.7): Terms text → bump `TERMS_VERSION`; `STRIPE_TAX_ENABLED`.
2. Shopify "Claude Sync": scopes read/write_discounts, read/write_draft_orders,
   read/write_gift_cards, read_products, read_publications, read_inventory;
   webhook `draft_orders/update`; Shopify secrets on production.
3. Workers Paid on.
4. R2 bucket (private) + `[[r2_buckets]] binding = "ROOMS"`.
5. Stripe live: same setup as A.1–A.2 in live mode (live key), production endpoint
   `https://api.springrenaissance.store/webhooks/stripe`; **disable the legacy Stripe
   webhook endpoint** (R1). `CIRCLE_STRIPE_LIVE = "on"`.
6. D1 production: `npx wrangler d1 migrations apply spring-renaissance --remote`
   (0006–0011; Time Travel bookmark first).
7. Deploy the Worker (`npx wrangler deploy`) — `LEGACY_VIP=off` takes effect here.
8. Admin: costs, Circle price list, catalog sync, welcome set, anniversary pool,
   releases; Economics "needs data" list empty.
9. `CIRCLE_PRICE_SYNC = "on"` (after the spike) → check Admin → Costs & Circle price
   status; storefront line appears.
10. Theme (draft): add `{% render 'sr-circle-price', product: product %}` under the
   price in the buy sections; place "SR — Members' object" on a Page; switch the
   patron-membership button to `https://club.springrenaissance.store/circle/join`;
   align the patron-membership copy with V2 (see the report's findings); publish.
11. Portal: `club.` → the V1/V2 portal build (`portal/dist`), remove the interim
   `_worker.js` (docs/launch-v1.md).
12. `CIRCLE_JOIN_OPEN = "on"`; `circle_open` email to the waiting list (one email).
13. Felix's real purchase → refund in Stripe → credits reversed correctly (T20).

## Rollback

- Join: `CIRCLE_JOIN_OPEN` off (nobody new can join; members unaffected).
- Member price: `CIRCLE_PRICE_SYNC` off, then deactivate "Circle price" discounts in Shopify.
- Worker: `wrangler rollback` to the previous version; legacy back with `LEGACY_VIP` removed.
- D1: Time Travel to the bookmark; `scripts/rollback/v2_down.sql` only while the Circle tables are empty.
