/**
 * Lazy adapter module registry.
 *
 * Shared between health-check.ts and update-fixtures.ts to
 * avoid duplicating the adapter import map. Uses dynamic
 * imports to avoid pulling in the full app dependency graph.
 */

import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Map of adapter keys to lazy-import functions.
 * Each entry returns the adapter's module without
 * eagerly resolving posthog, env, or other heavy deps.
 */
export const ADAPTER_MODULES: Record<string, () => Promise<unknown>> = {
  "cz-ns": async () => await import("./cz-ns"),
  "cz-nss": async () => await import("./cz-nss"),
  "cz-us": async () => await import("./cz-us"),
  "cz-regional": async () => await import("./cz-regional"),
  "sk-courts": async () => await import("./sk-courts"),
  "pl-courts": async () => await import("./pl-courts"),
  "at-courts": async () => await import("./at-courts"),
  "eu-ecj": async () => await import("./eu-ecj"),
};

/**
 * Load a single adapter by key. Returns undefined if the
 * key is not registered or the module fails to import.
 */
export const loadAdapterByKey = async (
  key: string,
): Promise<SourceAdapter | undefined> => {
  if (!(key in ADAPTER_MODULES)) {
    return undefined;
  }
  const loader = ADAPTER_MODULES[key];
  if (!loader) {
    return undefined;
  }
  const mod = await loader();
  if (!isRecord(mod)) {
    return undefined;
  }
  return Object.values(mod).find(
    (v): v is SourceAdapter =>
      isRecord(v) &&
      typeof v["key"] === "string" &&
      typeof v["fetchPage"] === "function",
  );
};

/** List all registered adapter keys. */
export const listAdapterKeys = (): string[] => Object.keys(ADAPTER_MODULES);
