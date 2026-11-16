import type { DataSourceTool } from "@/api/lib/data-sources/contract";
import { createCzAresLookupTool } from "@/api/lib/data-sources/tools/cz-ares-lookup";
import { createCzCnbRateTool } from "@/api/lib/data-sources/tools/cz-cnb-rate";
import { createCzIsirProceedingsTool } from "@/api/lib/data-sources/tools/cz-isir-proceedings";

/**
 * Every tool a `tool-call` column may name. A stored column whose tool is not
 * listed is an invariant breach, never a column to skip silently.
 */
export const DATA_SOURCE_TOOLS: readonly DataSourceTool[] = Object.freeze([
  createCzAresLookupTool(),
  createCzIsirProceedingsTool(),
  createCzCnbRateTool(),
]);
