// Random tokens and hashes for links and sessions.

export function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 32 random bytes → 43 base64url characters.
export function randomToken(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return base64url(randomBytes(32));
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
