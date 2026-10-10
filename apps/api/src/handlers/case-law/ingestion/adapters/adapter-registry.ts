import type { Result } from "better-result";

import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
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
import { huBhgyAdapter } from "@/api/handlers/case-law/ingestion/adapters/hu-bhgy";
import { plCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { plKioAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import { plKisAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-kis";
import { plNcourtAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { plNsaAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import { plSnAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-sn";
import { plTkAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-tk";
import { plUodoAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-uodo";
import { plUokikAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-uokik";
import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { skUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
  type AdapterKey,
  type ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";

import { courtListenerImport } from "./courtlistener/import";
import { checkedSourceRegistrations } from "./source-registrations";

/**
 * The deferred-document drains, carried here because the registry is how
 * anything outside this slice reaches an adapter.
 */
export { listDeferredDocumentDrains } from "@/api/handlers/case-law/ingestion/adapters/deferred-document-processors";

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
  [ADAPTER_KEYS.PL_SN]: plSnAdapter,
  [ADAPTER_KEYS.PL_KIO]: plKioAdapter,
  [ADAPTER_KEYS.PL_TK]: plTkAdapter,
  [ADAPTER_KEYS.PL_NSA]: plNsaAdapter,
  [ADAPTER_KEYS.PL_NCOURT]: plNcourtAdapter,
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
  [ADAPTER_KEYS.HU_BHGY]: huBhgyAdapter,
  [ADAPTER_KEYS.PL_KIS]: plKisAdapter,
  [ADAPTER_KEYS.PL_UODO]: plUodoAdapter,
  [ADAPTER_KEYS.PL_UOKIK]: plUokikAdapter,
} as const satisfies AdapterRegistry;

type SourceImport = Pick<
  SourceAdapter,
  "name" | "country" | "language" | "sourceFields" | "sourceSurfaces"
> & {
  readonly key: ImportSourceKey;
  readonly mapRecord: (input: unknown) => Result<IngestionResult, unknown>;
  readonly reparseStoredRaw: NonNullable<SourceAdapter["reparseStoredRaw"]>;
};

type ImportRegistry = {
  readonly [TKey in ImportSourceKey]: SourceImport & { readonly key: TKey };
};

const IMPORT_REGISTRY = {
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: courtListenerImport,
} as const satisfies ImportRegistry;

const SOURCE_REGISTRATIONS = [
  ...Object.values(ADAPTER_KEYS).map(
    (key) =>
      ({ key, capability: "crawl", source: ADAPTER_REGISTRY[key] }) as const,
  ),
  ...Object.values(IMPORT_SOURCE_KEYS).map(
    (key) =>
      ({ key, capability: "import", source: IMPORT_REGISTRY[key] }) as const,
  ),
];

export type SourceRegistration = (typeof SOURCE_REGISTRATIONS)[number];
export type SourceRegistrationKey = SourceRegistration["key"];

/** Both importers and crawlers participate in inventory and surface conformance. */
export const listSourceRegistrations = (): readonly SourceRegistration[] =>
  checkedSourceRegistrations(SOURCE_REGISTRATIONS);

export const getSourceRegistration = (
  key: string,
): SourceRegistration | undefined =>
  listSourceRegistrations().find((registration) => registration.key === key);

/** Look up an adapter by its key. */
export const getAdapter = (key: string): SourceAdapter | undefined => {
  const registration = getSourceRegistration(key);
  return registration?.capability === "crawl" ? registration.source : undefined;
};

/** List all registered adapters. */
export const listAdapters = (): readonly AdapterRegistry[AdapterKey][] =>
  listSourceRegistrations().flatMap((registration) =>
    registration.capability === "crawl" ? [registration.source] : [],
  );

/** List all registered adapter keys. */
export const listAdapterKeys = (): readonly AdapterKey[] =>
  Object.values(ADAPTER_KEYS);

/** Decision-producing sources with an inline or deferred document stage. */
export const listDocumentStageAdapters = () =>
  listAdapters().map(({ key, documentStage }) => ({ key, documentStage }));
