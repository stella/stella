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

const ADAPTER_REGISTRY: ReadonlyMap<string, SourceAdapter> = new Map([
  [czNsAdapter.key, czNsAdapter],
  [czNssAdapter.key, czNssAdapter],
  [czUsAdapter.key, czUsAdapter],
  [czRegionalAdapter.key, czRegionalAdapter],
  [skCourtsAdapter.key, skCourtsAdapter],
  [skUsAdapter.key, skUsAdapter],
  [plCourtsAdapter.key, plCourtsAdapter],
  [atCourtsAdapter.key, atCourtsAdapter],
  [euEcjAdapter.key, euEcjAdapter],
]);

/** Look up an adapter by its key. */
export const getAdapter = (key: string): SourceAdapter | undefined =>
  ADAPTER_REGISTRY.get(key);

/** List all registered adapters. */
export const listAdapters = (): SourceAdapter[] => [
  ...ADAPTER_REGISTRY.values(),
];
