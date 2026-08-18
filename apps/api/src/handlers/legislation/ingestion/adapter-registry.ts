import { LEGISLATION_ADAPTER_KEYS } from "@/api/lib/legal-search/legislation-ingestion-types";
import type {
  LegislationAdapterKey,
  LegislationSourceAdapter,
} from "@/api/lib/legal-search/legislation-ingestion-types";

/**
 * Which legislation adapter serves which source row's `adapter_key`.
 *
 * The mirror of `case-law/ingestion/adapters/adapter-registry.ts`, and total
 * for the same reason: a key declared in `LEGISLATION_ADAPTER_KEYS` with no
 * adapter behind it is a compile error, not a lookup that returns undefined
 * at run time on a machine nobody is watching.
 *
 * No lazy twin (`adapter-registry-lazy.ts`) yet. Case law needs one because
 * its health-check and fixture scripts load adapters outside the app process;
 * legislation has neither, and a second import map maintained by hand is the
 * drift the totality test exists to prevent.
 */

/**
 * A registry over `TKeys`: every key maps to the adapter that declares it.
 * Generic so the compile-time totality guard in the test exercises this exact
 * type against a key the real registry does not declare, rather than a copy
 * of it that could drift.
 */
export type LegislationAdapterRegistry<
  TKeys extends string = LegislationAdapterKey,
> = {
  readonly [TKey in TKeys]: LegislationSourceAdapter & { readonly key: TKey };
};

const LEGISLATION_ADAPTER_REGISTRY =
  {} as const satisfies LegislationAdapterRegistry;

/**
 * The registry read as the `adapter_key` column addresses it: an arbitrary
 * string. Widened once, here, so the lookup below stays a plain read rather
 * than a narrow-then-index dance whose every step is `never` until the first
 * key is declared.
 */
const REGISTRY_BY_KEY: Readonly<Record<string, LegislationSourceAdapter>> =
  LEGISLATION_ADAPTER_REGISTRY;

/**
 * Look up an adapter by its key, or nothing where no build declares that key.
 *
 * Undefined is not a fallback: an `adapter_key` this build does not declare is
 * a source row the caller must refuse to run rather than guess at.
 *
 * No run-time key-vs-slot check, unlike the case-law twin. The mapped type
 * above already requires the adapter in slot `K` to carry `key: K`, so an
 * adapter filed under the wrong key does not compile and there is nothing
 * left for a run-time comparison to catch.
 */
export const getLegislationAdapter = (
  key: string,
): LegislationSourceAdapter | undefined =>
  // Own properties only: the registry is an object literal, so a bare read
  // would answer `toString` and `constructor` with inherited members.
  Object.hasOwn(REGISTRY_BY_KEY, key) ? REGISTRY_BY_KEY[key] : undefined;

/** Every key that has an adapter registered against it. */
export const listRegisteredLegislationAdapterKeys = (): readonly string[] =>
  Object.keys(LEGISLATION_ADAPTER_REGISTRY);

/** Every declared key, whether or not the registry serves it. */
export const listLegislationAdapterKeys =
  (): readonly LegislationAdapterKey[] => LEGISLATION_ADAPTER_KEYS;
