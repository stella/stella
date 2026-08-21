import { panic } from "better-result";

import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { atAsylghAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-asylgh";
import { atBksAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-bks";
import { atBvwgAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-bvwg";
import { atCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import { atFindokAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-findok";
import { atLvwgAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-lvwg";
import { atUbasAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-ubas";
import { atUmseAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-umse";
import { atUvsAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-uvs";
import { atVergAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-verg";
import { atVfghAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-vfgh";
import { atVwghAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-vwgh";
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

type AdapterRegistry = {
  readonly [TKey in AdapterKey]: SourceAdapter & { readonly key: TKey };
};

const ADAPTER_REGISTRY = {
  [ADAPTER_KEYS.CZ_NS]: czNsAdapter,
  [ADAPTER_KEYS.CZ_NSS]: czNssAdapter,
  [ADAPTER_KEYS.CZ_US]: czUsAdapter,
  [ADAPTER_KEYS.CZ_REGIONAL]: czRegionalAdapter,
  [ADAPTER_KEYS.SK_COURTS]: skCourtsAdapter,
  [ADAPTER_KEYS.SK_US]: skUsAdapter,
  [ADAPTER_KEYS.PL_COURTS]: plCourtsAdapter,
  [ADAPTER_KEYS.AT_COURTS]: atCourtsAdapter,
  [ADAPTER_KEYS.AT_VFGH]: atVfghAdapter,
  [ADAPTER_KEYS.AT_VWGH]: atVwghAdapter,
  [ADAPTER_KEYS.AT_BVWG]: atBvwgAdapter,
  [ADAPTER_KEYS.AT_LVWG]: atLvwgAdapter,
  [ADAPTER_KEYS.AT_ASYLGH]: atAsylghAdapter,
  [ADAPTER_KEYS.AT_UBAS]: atUbasAdapter,
  [ADAPTER_KEYS.AT_UVS]: atUvsAdapter,
  [ADAPTER_KEYS.AT_VERG]: atVergAdapter,
  [ADAPTER_KEYS.AT_UMSE]: atUmseAdapter,
  [ADAPTER_KEYS.AT_BKS]: atBksAdapter,
  [ADAPTER_KEYS.AT_FINDOK]: atFindokAdapter,
  [ADAPTER_KEYS.EU_ECJ]: euEcjAdapter,
} as const satisfies AdapterRegistry;

const adapterKeyFromString = (key: string): AdapterKey | undefined =>
  Object.values(ADAPTER_KEYS).find((candidate) => candidate === key);

/** Look up an adapter by its key. */
export const getAdapter = (key: string): SourceAdapter | undefined => {
  const adapterKey = adapterKeyFromString(key);
  if (adapterKey === undefined) {
    return undefined;
  }
  const adapter = ADAPTER_REGISTRY[adapterKey];
  return adapter.key === adapterKey
    ? adapter
    : panic(`Adapter registry key mismatch for ${adapterKey}`);
};

/** List all registered adapters. */
export const listAdapters = (): SourceAdapter[] =>
  Object.values(ADAPTER_REGISTRY);

/** List all registered adapter keys. */
export const listAdapterKeys = (): readonly AdapterKey[] =>
  Object.values(ADAPTER_KEYS);
