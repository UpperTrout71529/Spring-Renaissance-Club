// The texts a person agrees to when joining (spec v1.1 §14.2). The server is
// the only source: the portal shows exactly these strings, and the consent
// record stores a hash of what was shown. Bump TERMS_VERSION whenever the
// Membership Terms or these texts change (pending legal review, P0.7).

export const TERMS_VERSION = "membership-terms-draft-2026-10-16";

export const CONSENT_TEXTS = Object.freeze({
  terms: "I agree to the Membership Terms and to automatic monthly renewal.",
  age_18: "I am 18 or older.",
});

export const REGION_NOTE = "The Circle is currently available in the United States.";

const usd = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

export function formatLongDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// The same calendar day next month, clamped to the month's end (as Stripe
// anchors a monthly subscription started on the 31st).
export function addMonthsIso(nowMs, months = 1) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), last);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}

// §14.2: shown next to the button and in Stripe Checkout (custom_text.submit).
// Rejoin uses §14.2's second text, which has no opening sentence.
export function disclosure({ firstChargeCents, monthlyCents, firstRenewalOn, rejoin = false }) {
  return `${rejoin ? "" : "By joining, you agree to the Membership Terms. "}You'll be charged ${usd(firstChargeCents)} today, then ${usd(monthlyCents)} plus applicable tax every month starting ${formatLongDate(firstRenewalOn)}, until you cancel. Cancel anytime online in your account — it takes effect at the end of your paid month.`;
}
