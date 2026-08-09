import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { atCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { czNssAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import { czRegionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { czUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import { euEcjAdapter } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { plCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { skUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

const ADAPTER_REGISTRY = {
  [ADAPTER_KEYS.CZ_NS]: czNsAdapter,
  [ADAPTER_KEYS.CZ_NSS]: czNssAdapter,
  [ADAPTER_KEYS.CZ_US]: czUsAdapter,
  [ADAPTER_KEYS.CZ_REGIONAL]: czRegionalAdapter,
  [ADAPTER_KEYS.SK_COURTS]: skCourtsAdapter,
  [ADAPTER_KEYS.SK_US]: skUsAdapter,
  [ADAPTER_KEYS.PL_COURTS]: plCourtsAdapter,
  [ADAPTER_KEYS.AT_COURTS]: atCourtsAdapter,
  [ADAPTER_KEYS.EU_ECJ]: euEcjAdapter,
} as const satisfies Record<AdapterKey, SourceAdapter>;

const adapterKeyFromString = (key: string): AdapterKey | undefined =>
  Object.values(ADAPTER_KEYS).find((candidate) => candidate === key);

/** Look up an adapter by its key. */
export const getAdapter = (key: string): SourceAdapter | undefined => {
  const adapterKey = adapterKeyFromString(key);
  return adapterKey === undefined ? undefined : ADAPTER_REGISTRY[adapterKey];
};

/** List all registered adapters. */
export const listAdapters = (): SourceAdapter[] =>
  Object.values(ADAPTER_REGISTRY);

/** List all registered adapter keys. */
export const listAdapterKeys = (): readonly AdapterKey[] =>
  Object.values(ADAPTER_KEYS);
