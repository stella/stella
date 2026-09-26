/**
 * Opaque bearer tokens for browser-to-desktop handoffs and the desktop
 * sessions they open.
 *
 * 64 lowercase hex characters carrying two UUIDv7 values, so a token has ~148
 * random bits and a fixed length every endpoint can check before it hashes.
 * Only the SHA-256 hex is stored; the raw token exists in the deep link and
 * the redeem response and is never logged.
 */

const OPAQUE_TOKEN_LENGTH = 64;

const OPAQUE_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

const TOKEN_PART_LENGTH = 32;

export const createOpaqueToken = () =>
  Bun.randomUUIDv7().replaceAll("-", "").slice(0, TOKEN_PART_LENGTH) +
  Bun.randomUUIDv7().replaceAll("-", "").slice(0, TOKEN_PART_LENGTH);

export const hashOpaqueToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

/**
 * Exact length first, then shape: a length check on the raw input keeps a
 * pathological string out of the regex engine, and both run before the hash
 * lookup that does the constant-time comparison.
 */
export const isOpaqueTokenShape = (value: string): boolean =>
  value.length === OPAQUE_TOKEN_LENGTH && OPAQUE_TOKEN_PATTERN.test(value);
