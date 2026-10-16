// A fake Cloudflare Access: an RSA key pair, its JWKS at the team domain's
// /cdn-cgi/access/certs, and a signer for the Cf-Access-Jwt-Assertion JWT.

import { base64url } from '../src/lib/crypto.js';

export const TEAM = 'https://sr-team.cloudflareaccess.com';
export const AUD = 'aud-tag-sr-admin';
export const ADMIN = 'felix@example.com';

export async function makeAccess({ kid = 'kid-1' } = {}) {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const access = {
    certFetches: 0,
    jwks: { keys: [jwk] },
    // Answers the certs URL; returns null for anything else.
    fetch(url) {
      if (String(url) !== `${TEAM}/cdn-cgi/access/certs`) return null;
      access.certFetches++;
      return Response.json({ keys: access.jwks.keys });
    },
    async sign(claims = {}, { key = keys.privateKey, header = {} } = {}) {
      const nowS = Math.floor(Date.parse('2026-10-15T12:00:00.000Z') / 1000);
      const payload = { aud: [AUD], email: ADMIN, iss: TEAM, iat: nowS, nbf: nowS, exp: nowS + 3600, sub: 'u1', type: 'app', ...claims };
      const enc = (o) => base64url(new TextEncoder().encode(JSON.stringify(o)));
      const input = `${enc({ alg: 'RS256', kid, typ: 'JWT', ...header })}.${enc(payload)}`;
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
      return `${input}.${base64url(new Uint8Array(sig))}`;
    },
    otherKey: async () => (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    )).privateKey,
  };
  return access;
}

export const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: `${ADMIN}, Second@Example.com` };

// Wraps a world's fetch so the certs URL is answered by the fake Access.
export function withAccess(world, access) {
  const inner = world.fetch;
  world.fetch = async (url, init) => access.fetch(url) || inner(url, init);
  return world;
}
