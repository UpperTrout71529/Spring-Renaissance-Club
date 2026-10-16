// ULID (https://github.com/ulid/spec): 48-bit millisecond time + 80 random
// bits, Crockford base32, 26 characters. Lexicographic order = time order, so
// IDs double as a creation-time sort key.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

// nowMs and randomBytes are injected so tests can pin both.
export function ulid(nowMs = Date.now(), randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIME) {
    throw new RangeError("ulid: time out of range");
  }
  let time = "";
  let t = nowMs;
  for (let i = 0; i < TIME_LEN; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 256 is a multiple of 32, so taking the low 5 bits of a uniform byte is
  // itself uniform — no modulo bias.
  const bytes = randomBytes(RANDOM_LEN);
  let rand = "";
  for (let i = 0; i < RANDOM_LEN; i++) rand += ALPHABET[bytes[i] & 31];
  return time + rand;
}

export function ulidTime(id) {
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = ALPHABET.indexOf(id[i]);
    if (v < 0) throw new RangeError("ulidTime: not a ULID");
    t = t * 32 + v;
  }
  return t;
}
