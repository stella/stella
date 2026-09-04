import {
  type SafeId as PortableSafeId,
  type SafeIdType,
} from "@stll/api-contract";
// The brander stays behind its own entry point, which each app re-exports
// once; this module is the API's one re-export.
import { toSafeId as toPortableSafeId } from "@stll/api-contract/safe-id";

export type { SafeIdType } from "@stll/api-contract";

export type SafeId<T extends SafeIdType> = PortableSafeId<T>;

/**
 * Id types minted by the auth provider rather than by `createSafeId`. Their
 * columns are opaque text, never `uuid`: Better Auth's default generator
 * produces 32 base62 characters, and a configured generator may produce
 * UUIDs. Nothing in this codebase mints one; `createSafeId` refuses these
 * types so a fixture or handler cannot invent a UUID-shaped user id that no
 * real row ever carries. Parse one with `parseAuthProviderId`; tests mint
 * them with `mintAuthProviderId`.
 */
export const AUTH_PROVIDER_ID_TYPES = [
  "organization",
  "user",
] as const satisfies readonly SafeIdType[];

export type AuthProviderIdType = (typeof AUTH_PROVIDER_ID_TYPES)[number];

/** Id types this codebase mints itself, as UUIDv7. */
export type MintedSafeIdType = Exclude<SafeIdType, AuthProviderIdType>;

/**
 * The contract's brander, narrowed to the id types this codebase knows. The
 * portable signature accepts any string as the type parameter, which would let
 * a misspelled `toSafeId<"mater">` compile; inside the API the set is closed.
 */
export const toSafeId: <T extends SafeIdType>(value: string) => SafeId<T> =
  toPortableSafeId;

export const createSafeId = <T extends MintedSafeIdType>(): SafeId<T> =>
  toSafeId<T>(Bun.randomUUIDv7());
