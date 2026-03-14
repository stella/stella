/**
 * Lazy adapter module registry.
 *
 * Shared between health-check.ts and update-fixtures.ts to
 * avoid duplicating the adapter import map. Uses dynamic
 * imports to avoid pulling in the full app dependency graph.
 */

import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";

/**
 * Map of adapter keys to lazy-import functions.
 * Each entry returns the adapter's module without
 * eagerly resolving posthog, env, or other heavy deps.
 */
export const ADAPTER_MODULES: Record<string, () => Promise<unknown>> = {
  "cz-constitutional": async () => await import("./cz-constitutional"),
  "cz-regional": async () => await import("./cz-regional"),
  "cz-supreme": async () => await import("./cz-supreme"),
  "cz-supreme-admin": async () => await import("./cz-supreme-admin"),
  "sk-courts": async () => await import("./sk-courts"),
  "pl-courts": async () => await import("./pl-courts"),
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
    return;
  }
  const loader = ADAPTER_MODULES[key];
  const mod = await loader();
  // SAFETY: dynamic import returns a module object; we
  // narrow via the type guard below.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const entries = mod as Record<string, unknown>;
  return Object.values(entries).find(
    (v): v is SourceAdapter =>
      typeof v === "object" &&
      v !== null &&
      "key" in v &&
      "fetchPage" in v,
  );
};

/** List all registered adapter keys. */
export const listAdapterKeys = (): string[] =>
  Object.keys(ADAPTER_MODULES);
