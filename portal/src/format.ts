// Dates and money. Always en-US (Felix, 16 Oct 2026): the interface is
// English, so "Oct 2, 2026" and "$1,234.50" — never a browser-locale mix such
// as "2 окт. 2026 г." inside English copy. Spec §6.9's per-locale formatting
// returns with a second language. Money arrives as integer cents.

const LOCALE = "en-US";

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(cents / 100);
}

// Shopify CDN images at the size they are shown (spec §6.1).
export function sized(url: string, width: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}
