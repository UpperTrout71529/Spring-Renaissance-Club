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
| D3 | Temporary data mode (Felix §18): shipping estimates per class S/M/L live in `economics_settings` (`shipping_s_cents` …) with a per-class `estimate` flag; each variant cost row names its class. A variant whose class is an estimate needs `estimate_min_margin_bps` (2500) instead of `min_margin_bps` (1500). | Felix's rule. | Admin → Economics: enter exact shipping and clear the estimate flag. |
