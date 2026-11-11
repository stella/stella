/**
 * Keyed SHA-256 under Bun. Kept apart from `bun.ts` so modules that depend
 * on plain hashing do not depend on this one.
 */

/** HMAC-SHA-256 of `input` under `key`, as hex. */
export const hmacSha256Hex = (
  key: Uint8Array,
  input: string | Uint8Array,
): string => new Bun.CryptoHasher("sha256", key).update(input).digest("hex");
