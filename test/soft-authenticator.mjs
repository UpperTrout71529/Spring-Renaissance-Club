// A software WebAuthn authenticator for tests: a real P-256 key, real
// authenticatorData, a CBOR "none" attestation and DER signatures, so the
// responses go through @simplewebauthn/server's verification unmodified.

import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

const enc = (s) => new TextEncoder().encode(s);
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const b64 = (bytes) => isoBase64URL.fromBuffer(bytes);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u32(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

// WebCrypto signs ECDSA as raw r||s; WebAuthn wants ASN.1 DER.
function derSignature(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export async function createSoftAuthenticator({ origin = 'https://club.springrenaissance.store', rpId = 'springrenaissance.store' } = {}) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = b64(credentialId);
  let counter = 0;
  let userHandle = null;

  const cosePublicKey = isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, isoBase64URL.toBuffer(jwk.x)],
    [-3, isoBase64URL.toBuffer(jwk.y)],
  ]));

  return {
    id,
    get counter() { return counter; },

    async register(options, { uv = true, originOverride, rpIdOverride } = {}) {
      userHandle = options.user.id;
      const clientDataJSON = enc(JSON.stringify({
        type: 'webauthn.create', challenge: options.challenge, origin: originOverride || origin, crossOrigin: false,
      }));
      const attested = concat(
        new Uint8Array(16), // AAGUID: zeros, as "none" attestation authenticators report
        new Uint8Array([0, credentialId.length]), credentialId, cosePublicKey,
      );
      const authData = concat(
        await sha256(enc(rpIdOverride || rpId)),
        new Uint8Array([FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_AT]),
        u32(counter),
        attested,
      );
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id, rawId: id, type: 'public-key',
        response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
        clientExtensionResults: {}, authenticatorAttachment: 'platform',
      };
    },

    async authenticate(options, { uv = true, originOverride, userHandleOverride } = {}) {
      counter += 1;
      const clientDataJSON = enc(JSON.stringify({
        type: 'webauthn.get', challenge: options.challenge, origin: originOverride || origin, crossOrigin: false,
      }));
      const authenticatorData = concat(
        await sha256(enc(rpId)),
        new Uint8Array([FLAG_UP | (uv ? FLAG_UV : 0)]),
        u32(counter),
      );
      const raw = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, concat(authenticatorData, await sha256(clientDataJSON)),
      ));
      return {
        id, rawId: id, type: 'public-key',
        response: {
          clientDataJSON: b64(clientDataJSON),
          authenticatorData: b64(authenticatorData),
          signature: b64(derSignature(raw)),
          userHandle: userHandleOverride !== undefined ? userHandleOverride : userHandle,
        },
        clientExtensionResults: {}, authenticatorAttachment: 'platform',
      };
    },
  };
}
