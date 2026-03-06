import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { czRegionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { czSupremeAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-supreme";
import { czSupremeAdminAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-supreme-admin";
import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";

const ADAPTER_REGISTRY: ReadonlyMap<string, SourceAdapter> = new Map([
  [czRegionalAdapter.key, czRegionalAdapter],
  [czSupremeAdapter.key, czSupremeAdapter],
  [czSupremeAdminAdapter.key, czSupremeAdminAdapter],
  [skCourtsAdapter.key, skCourtsAdapter],
]);

/** Look up an adapter by its key. */
export const getAdapter = (key: string): SourceAdapter | undefined =>
  ADAPTER_REGISTRY.get(key);

/** List all registered adapters. */
export const listAdapters = (): SourceAdapter[] => [
  ...ADAPTER_REGISTRY.values(),
];
