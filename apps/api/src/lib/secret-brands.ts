// Branded string types for in-process secrets. The compiler treats each
// brand as a distinct type, so swapping a refresh token for a client secret
// (or vice versa) becomes a type error rather than a silent string mix-up.
//
// These brands sit alongside the SafeId family in branded-types.ts but use
// their own __secret symbol so the SecretKind union stays separate from
// SafeIdType and the two cannot accidentally cross-cast.
//
// Brand boundaries:
//   - Decryption helpers (decryptMcpSecret) mint brands from raw strings at
//     the decrypt boundary via a local cast and the purpose discriminator.
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
