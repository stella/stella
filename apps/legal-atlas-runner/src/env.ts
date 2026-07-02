import { panic } from "better-result";

type IntegerEnvOptions = {
  name: string;
  fallback: number;
  min: number;
};

const readIntegerEnv = ({ name, fallback, min }: IntegerEnvOptions): number => {
  const raw = Bun.env[name]?.trim();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  if (!/^\d+$/u.test(raw)) {
    panic(`${name} must be an integer`);
  }

  const parsed = Number(raw);

  if (!Number.isSafeInteger(parsed)) {
    panic(`${name} must be a safe integer`);
  }

  if (parsed < min) {
    panic(`${name} must be at least ${min}`);
  }

  return parsed;
};

export const LEGAL_ATLAS_RUNNER_ENV = {
  disabledAdapters: Bun.env["DISABLED_ADAPTERS"] ?? "",
  maxConcurrentDbWrites: readIntegerEnv({
    name: "MAX_CONCURRENT_DB_WRITES",
    fallback: 2,
    min: 1,
  }),
  // Cap on adapters crawling at once. Each cycle fetches + enriches + parses
  // outside the DB-write semaphore, so without this bound every source crawls
  // its backlog concurrently and saturates a small worker (0.5 vCPU), starving
  // the event loop so no page completes within its cycle budget.
  maxConcurrentAdapterCycles: readIntegerEnv({
    name: "MAX_CONCURRENT_ADAPTER_CYCLES",
    fallback: 2,
    min: 1,
  }),
  // 0 disables the runner's transaction timeout. Non-zero values are installed
  // as a transaction-local Postgres statement_timeout, with a short wall-clock
  // grace in db.ts for sockets that never report the server-side cancellation.
  dbTransactionTimeoutMs: readIntegerEnv({
    name: "DB_TRANSACTION_TIMEOUT_MS",
    fallback: 1_200_000,
    min: 0,
  }),
  // Per-transaction budget for the index-maintenance backfill loops. Sized
  // above CORPUS_BACKFILL_STATEMENT_TIMEOUT (15min), which the tsvector
  // projection upserts deliberately raise for very long court decisions;
  // every other backfill transaction (batch select, audit insert, CAS
  // update) finishes in seconds. 0 disables the runner's bound.
  dbBackfillTransactionTimeoutMs: readIntegerEnv({
    name: "DB_BACKFILL_TRANSACTION_TIMEOUT_MS",
    fallback: 960_000,
    min: 0,
  }),
  // Root-pool reads/writes (source lookup + one-time seed insert) are tiny;
  // a short ceiling fails fast on a dead connection at cycle start.
  dbRootQueryTimeoutMs: readIntegerEnv({
    name: "DB_ROOT_QUERY_TIMEOUT_MS",
    fallback: 30_000,
    min: 0,
  }),
} as const;
