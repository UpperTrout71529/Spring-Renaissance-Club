// Dates and money (spec §6.9): formatted with Intl for the visitor's locale,
// currency always as the API says (USD). Money arrives as integer cents.

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(navigator.language, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(navigator.language, { style: "currency", currency }).format(cents / 100);
}

// Shopify CDN images at the size they are shown (spec §6.1).
export function sized(url: string, width: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}
