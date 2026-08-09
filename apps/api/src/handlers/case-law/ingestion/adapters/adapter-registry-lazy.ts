/**
 * Lazy adapter module registry.
 *
 * Shared between health-check.ts and update-fixtures.ts to
 * avoid duplicating the adapter import map. Uses dynamic
 * imports to avoid pulling in the full app dependency graph.
 */

import { panic } from "better-result";

import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

type AdapterLoader = () => Promise<SourceAdapter>;

/**
 * Map of adapter keys to lazy-import functions.
 * Each entry returns the adapter's module without
 * eagerly resolving posthog, env, or other heavy deps.
 */
export const ADAPTER_MODULES = {
  [ADAPTER_KEYS.CZ_NS]: async () => (await import("./cz-ns")).czNsAdapter,
  [ADAPTER_KEYS.CZ_NSS]: async () => (await import("./cz-nss")).czNssAdapter,
  [ADAPTER_KEYS.CZ_US]: async () => (await import("./cz-us")).czUsAdapter,
  [ADAPTER_KEYS.CZ_REGIONAL]: async () =>
    (await import("./cz-regional")).czRegionalAdapter,
  [ADAPTER_KEYS.SK_COURTS]: async () =>
    (await import("./sk-courts")).skCourtsAdapter,
  [ADAPTER_KEYS.SK_US]: async () => (await import("./sk-us")).skUsAdapter,
  [ADAPTER_KEYS.PL_COURTS]: async () =>
    (await import("./pl-courts")).plCourtsAdapter,
  [ADAPTER_KEYS.AT_COURTS]: async () =>
    (await import("./at-courts")).atCourtsAdapter,
  [ADAPTER_KEYS.EU_ECJ]: async () => (await import("./eu-ecj")).euEcjAdapter,
} as const satisfies Record<AdapterKey, AdapterLoader>;

const adapterKeyFromString = (key: string): AdapterKey | undefined =>
  Object.values(ADAPTER_KEYS).find((candidate) => candidate === key);

/**
 * Load a single adapter by key. Returns undefined if the key is not
 * registered. Import failures propagate to the caller.
 */
export const loadAdapterByKey = async (
  key: string,
): Promise<SourceAdapter | undefined> => {
  const adapterKey = adapterKeyFromString(key);
  if (adapterKey === undefined) {
    return undefined;
  }
  const adapter = await ADAPTER_MODULES[adapterKey]();
  if (adapter.key !== adapterKey) {
    return panic(`Adapter registry key mismatch for ${adapterKey}`);
  }
  return adapter;
};

/** List all registered adapter keys. */
export const listAdapterKeys = (): readonly AdapterKey[] =>
  Object.values(ADAPTER_KEYS);
