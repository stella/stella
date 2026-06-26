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
  // Wall-clock ceiling on a single ingestion transaction. A dead pooled
  // connection can otherwise hang a read forever; this rejects it so the
  // adapter loop retries instead of wedging until the cycle hard deadline
  // force-exits the worker. Must exceed the longest legitimate statement
  // (the search-index backfill raises its statement_timeout to 15min).
  dbTransactionTimeoutMs:
    Number.parseInt(Bun.env["DB_TRANSACTION_TIMEOUT_MS"] ?? "1200000", 10) ||
    1_200_000,
  // Root-pool reads/writes (source lookup + one-time seed insert) are tiny;
  // a short ceiling fails fast on a dead connection at cycle start.
  dbRootQueryTimeoutMs:
    Number.parseInt(Bun.env["DB_ROOT_QUERY_TIMEOUT_MS"] ?? "30000", 10) ||
    30_000,
} as const;
