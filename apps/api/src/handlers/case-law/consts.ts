/** Adapter keys for all supported court data sources. */
export const ADAPTER_KEYS = {
  CZ_REGIONAL: "cz-regional",
  CZ_SUPREME: "cz-supreme",
  CZ_SUPREME_ADMIN: "cz-supreme-admin",
  CZ_CONSTITUTIONAL: "cz-constitutional",
  SK_COURTS: "sk-courts",
} as const;

export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];

/** Maximum number of pages to sync per invocation. */
export const MAX_SYNC_PAGES = 100;
