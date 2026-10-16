// Dates and money. Always en-US (Felix, 16 Oct 2026): the interface is
// English, so "Oct 2, 2026" and "$1,234.50" — never a browser-locale mix such
// as "2 окт. 2026 г." inside English copy. Spec §6.9's per-locale formatting
// returns with a second language. Money arrives as integer cents.

const LOCALE = "en-US";

// A calendar date without a time ("2027-10-01", e.g. a gift card's expiresOn)
// is the same day everywhere: format it in UTC, or a visitor west of
// Greenwich would see the day before. A timestamp is shown in the device's
// time zone.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(iso: string): string {
  const dateOnly = DATE_ONLY.test(iso);
  return new Intl.DateTimeFormat(LOCALE, {
    month: "short", day: "numeric", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}),
  }).format(new Date(dateOnly ? `${iso}T00:00:00Z` : iso));
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(cents / 100);
}

// Shopify CDN images at the size they are shown (spec §6.1).
export function sized(url: string, width: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}
