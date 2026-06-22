export const LEGAL_ATLAS_RUNNER_ENV = {
  disabledAdapters: Bun.env["DISABLED_ADAPTERS"] ?? "",
  maxConcurrentDbWrites:
    Number.parseInt(Bun.env["MAX_CONCURRENT_DB_WRITES"] ?? "2", 10) || 2,
  // Cap on adapters crawling at once. Each cycle fetches + enriches + parses
  // outside the DB-write semaphore, so without this bound every source crawls
  // its backlog concurrently and saturates a small worker (0.5 vCPU), starving
  // the event loop so no page completes within its cycle budget.
  maxConcurrentAdapterCycles:
    Number.parseInt(Bun.env["MAX_CONCURRENT_ADAPTER_CYCLES"] ?? "2", 10) || 2,
} as const;
