import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { czConstitutionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-constitutional";
import { czRegionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { czSupremeAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-supreme";
import { czSupremeAdminAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-supreme-admin";
import { plCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";

const ADAPTER_REGISTRY: ReadonlyMap<string, SourceAdapter> = new Map([
  [czConstitutionalAdapter.key, czConstitutionalAdapter],
  [czRegionalAdapter.key, czRegionalAdapter],
  [czSupremeAdapter.key, czSupremeAdapter],
  [czSupremeAdminAdapter.key, czSupremeAdminAdapter],
  [skCourtsAdapter.key, skCourtsAdapter],
  [plCourtsAdapter.key, plCourtsAdapter],
]);

/** Look up an adapter by its key. */
export const getAdapter = (key: string): SourceAdapter | undefined =>
  ADAPTER_REGISTRY.get(key);

/** List all registered adapters. */
export const listAdapters = (): SourceAdapter[] => [
  ...ADAPTER_REGISTRY.values(),
];
