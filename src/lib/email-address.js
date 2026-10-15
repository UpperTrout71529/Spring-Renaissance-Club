// Email normalisation and a deliberately strict plausibility check. Quotes and
// backslashes are refused: they are legal in RFC 5321 local parts, never seen
// from real customers, and would otherwise have to be escaped into Shopify's
// search syntax.

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isPlausibleEmail(email) {
  return typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@"\\]+@[^\s@."\\]+(\.[^\s@."\\]+)+$/.test(email);
}

// For logs: c***@gmail.com (spec §13.1).
export function maskEmail(email) {
  const at = typeof email === "string" ? email.indexOf("@") : -1;
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
