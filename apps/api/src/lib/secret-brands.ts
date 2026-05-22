// Branded string types for in-process secrets. The compiler treats each
// brand as a distinct type, so swapping a refresh token for a client secret
// (or vice versa) becomes a type error rather than a silent string mix-up.
//
// These brands sit alongside the SafeId family in branded-types.ts but use
// their own __secret symbol so the SecretKind union stays separate from
// SafeIdType and the two cannot accidentally cross-cast.
//
// Brand boundaries:
//   - Decryption helpers (decryptMcpSecret) mint brands from raw strings via
//     the purpose discriminator.
//   - Consumers receive branded values and pass them as branded named-arg
//     fields; TypeScript catches both swaps and any plain-string detours.
//   - The brand carries no runtime cost; logs/serialization see plain strings,
//     which is what the `no-secret-in-log-sink` lint rule guards.

declare const __secret: unique symbol;

export type SecretKind =
  | "AccessToken"
  | "ApiKey"
  | "AuthSecret"
  | "ClientSecret"
  | "RefreshToken"
  | "StaticBearerToken";

export type Secret<K extends SecretKind> = string & {
  readonly [__secret]: K;
};

export type AccessToken = Secret<"AccessToken">;
export type ApiKey = Secret<"ApiKey">;
export type AuthSecret = Secret<"AuthSecret">;
export type ClientSecret = Secret<"ClientSecret">;
export type RefreshToken = Secret<"RefreshToken">;
export type StaticBearerToken = Secret<"StaticBearerToken">;

// Brand-mint boundary: every call site of toSecret must sit inside a
// trusted module (decrypt/env-load) that has already validated the value.
// Mirrors the toSafeId pattern in branded-types.ts. The no-restricted-imports
// override in oxlint.config.ts limits the importable surface.
// SAFETY: nominal brand; the caller asserts the value originated from a
// trusted boundary and matches the declared kind.
export const toSecret = <K extends SecretKind>(value: string): Secret<K> =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  value as Secret<K>;
