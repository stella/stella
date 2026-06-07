export const LEGAL_ATLAS_RUNNER_ENV = {
  disabledAdapters: Bun.env["DISABLED_ADAPTERS"] ?? "",
  maxConcurrentDbWrites:
    Number.parseInt(Bun.env["MAX_CONCURRENT_DB_WRITES"] ?? "2", 10) || 2,
} as const;
