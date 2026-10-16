# V2 Circle — decisions

Spec: `docs/tz-v2-circle.md` (v0.1). Felix answered §19 on 16 Oct 2026 and
asked for an autonomous build; every choice he did not make is recorded here
as: decision — why — how to change it.

## Felix's answers to §19 (16 Oct 2026)

1. Member price: automatic discount for specific customers. The spike runs on a
   Shopify development store that Felix creates later. Build the main path now;
   describe the fallback (personal code from the portal).
2. Impersonation risk accepted. Such orders are flagged and Felix is notified.
3. Members' object: a separate page without a buy button.
4. After an expired reservation or a cancelled order a member may claim again.
   `canceling` members may not claim.
5. Anniversary: the renewal that opens month 13. A failed payment that is paid
   within the retry window does NOT reset the count; only the end of the
   subscription does.
6. Invitation: "second payment" = first invoice + first renewal. Season = UTC
   calendar quarter. A card/address match goes to manual review. The friend
   pays $40 instead of $50; the member gets +10 credits after the friend's
   second payment.
7. The 2% gift-card fee is accepted for now. Describe the alternative: credits
   as a single-use fixed-amount code for one customer that combines with the
   25% (no 2%). To be checked in the spike.
8. Workers Paid: no. Build on Free; Felix turns Paid on before launch. Limits
   hit on staging go to the blockers.
9. Tags `vip-circle` / `vip-circle-past`.
10. Rule 2 on the worst case (premium and international cards).
11. Early access = pre-order of new members' objects before the public
    release, through a draft order. I choose the mechanism and record it here.
    Last task. Not on the benefits page until it works.

§18: no exact figures yet; the Circle launches only once every figure exists.
Temporary data mode until then:
- 25% and the Circle price only for variants with an entered cost;
- shipping is Felix's estimate per class S/M/L; with an estimate the minimum
  margin is 25% instead of 15%; the admin labels such figures "estimate";
- welcome pieces come from Small Pleasures, at least 2, landed cost ≤ $25;
- no paid Radar; invitation amounts are the defaults ($10 / 10 credits).

## Build decisions

| # | Decision | Why | How to change |
|---|---|---|---|
| D1 | Branch `v2-circle` from `feat/lk-v1` @ `c725e17` (the V2 spec commit). | V2 builds on the V1 portal, which is not in `main` yet. | Rebase onto `main` once V1 is merged. |
| D2 | Migrations are numbered in the order they ship (0006, 0007, …), not by the spec's file names. | The suite enforces contiguous numbering. | — |
| D3 | Temporary data mode (Felix §18): shipping estimates per class S/M/L live in `economics_settings` (key `shipping`: `{ S|M|L: { cents, estimate } }`); each variant cost row names its class. A variant whose class is an estimate needs `estimate_min_margin_bps` (2500) instead of `min_margin_bps` (1500). | Felix's rule. | Admin → Economics: enter exact shipping and clear the estimate flag. |
| D4 | Every economics rule (2–5) uses the guard profile setting, default `worst` (premium + international cards). | Felix chose worst case for rule 2; the same profile everywhere is the simplest safe reading. With it the invitation threshold is c ≈ 0.45 instead of the brief's 0.46. | Admin → Economics: `guard_profile` = `expected`. |
| D5 | Cost per credit-dollar (c_avg, §12.5) is computed over variants that are ACTIVE, on the Online Store, not gift cards and not the membership product (`patron-membership`); capsules and Small Pleasures count. Any such variant without a cost → c_avg is empty → invitation rewards and anniversary gifts are suspended (fail closed). | Credits can buy all of these; a gap in costs would understate the cost. | Enter costs, or change `creditPurchasable` in `src/circle/economics-store.js`. |
| D6 | The welcome cap of $25 is landed cost **plus** the outbound shipping of the piece's class ("с доставкой"). An option can be active only with a landed cost; with no shipping entered for its class the economics treat the welcome basis as unknown. | Felix: "себестоимость с доставкой ≤ $25". | — |
| D7 | Admin writes (PUT/POST/DELETE under `/api/admin/*`) require `Origin` = the API's own origin and `X-SR-Client: admin`, on top of the Access JWT. | Spec §3.3: admin same-origin check; the portal headers are for club. only. | `assertAdminMutation` in `src/http/cors.js`. |
| D8 | The Shopify catalog is read into `catalog_variants` (query only) by an admin button or the daily cron; Circle price items are recomputed after every cost, list, settings or catalog change. | Economics need prices without a Shopify call per request; nothing in Shopify product data changes. | — |
| D9 | `consent_collection.terms_of_service` in Checkout is off until `STRIPE_CHECKOUT_TOS=on`; our own consents (hashed texts) are always recorded. | Stripe refuses that option until a Terms URL is set in the Dashboard; the portal already records the agreement. | Set the Terms URL in Stripe, then the var. |
| D10 | The welcome / welcome-back email is sent on the first paid invoice (`invoice.paid`, `subscription_create`), not on `checkout.session.completed`. | Both arrive together; only the invoice has the receipt link and the next charge date the email must state. | `src/circle/stripe-events.js` onInvoicePaid. |
| D11 | Circle subscriptions are recognised by `metadata.kind` (join/rejoin) set by our Checkout; every other Stripe object in the account is acknowledged and ignored. | The same Stripe account holds the legacy setup; nothing outside the Circle must be touched. | — |
| D12 | Status order: subscription snapshots carry `event.created`; an older snapshot never overwrites a newer one (`stripe_synced_at`); `ended` is terminal. A payment that recovers `past_due` returns to `canceling` if a cancellation is pending. | Stripe does not guarantee order (§16.3 #3). | — |
| D13 | Refund reversal = the invoice's credits × refunded share, rounded up to the cent, never more than the credits; repeated `charge.refunded` events reverse only the difference. Dispute: the invoice's credits are reversed in full and frozen; won (or warning closed) → restored and unfrozen if no other dispute is open; lost → stays reversed and frozen for Felix to decide. | Spec §9.1.4, T11. | — |
| D14 | `payment_failed` email on the first failure and before the last retry (attempt = `CIRCLE_PAYMENT_ATTEMPTS` − 1, default 4 attempts = 1 + 3 retries); none when Stripe has no further attempt. | Spec §9.1.4 with the custom retry schedule (3 retries). | Var `CIRCLE_PAYMENT_ATTEMPTS`. |
| D15 | "I've updated my card": `payment_method.attached`, or `customer.updated` whose previous attributes show a new default payment method, retries the newest open invoice of a past_due membership (`POST /v1/invoices/:id/pay`, idempotent). | Spec §9.1.4 recovery path. | — |
| D16 | The "too many credits" cancel offer says "They also work on Small Pleasures." — without the spec's "and gift cards for friends". | Credits are paid out as a Shopify gift card, and Shopify does not let a gift card pay for another gift card; only working things are promised. | `offerFor` in `src/routes/circle-cancel.js`. |
| D17 | Cancel flow states: `start` records the reason (outcome `abandoned`); `confirm` → `canceled` (Stripe cancel at period end; past_due → cancelled now, §16.3 #9); `keep` → `saved` (+ offer accepted); `undo` turns the last `canceled` into `saved`. No step-up for cancelling. | Spec §16.1 table; §14.2 cancel as easy as join. | — |
| D18 | Deleting an account with a membership: Stripe subscription cancelled first (fail closed → 503, nothing deleted), membership `ended_expired` with `account_deleted`, credits expire, welcome/anniversary addresses removed, Circle tags removed. Non-members keep the V1 behaviour exactly. | Spec §13.4, §16.3 #12. | `src/circle/account-delete.js`. |
| D19 | Welcome piece options must be Small Pleasures (product tag `catalog`) when the catalog snapshot exists; with an empty snapshot (staging without Shopify) the check is skipped. Unavailable variants (`availableForSale` false) are hidden from the choice when Shopify can be asked. | Felix §18; staging has no Shopify. | `assertSavable` in `src/circle/gifts.js`. |
| D20 | Gift orders (welcome now, anniversary later) are created only by Felix's admin button: the row is claimed first (one order per double click), the draft refuses automatic discounts and codes, is completed as paid ($0 lines, free "Circle welcome" shipping). `paymentPending` is deprecated in 2026-07, so it is not sent. A Shopify failure flags the row "needs attention". | Spec §9.2.6; nothing is created in the live store by the build. | — |
