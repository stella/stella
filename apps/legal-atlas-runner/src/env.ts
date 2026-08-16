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

type BooleanEnvOptions = {
  name: string;
  fallback: boolean;
};

/**
 * Strict on purpose: a loop gated on a misspelt value would read as
 * "off" and stay silent, which is the state the flag exists to make
 * deliberate.
 */
const readBooleanEnv = ({ name, fallback }: BooleanEnvOptions): boolean => {
  const raw = Bun.env[name]?.trim();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  if (raw !== "true" && raw !== "false") {
    panic(`${name} must be "true" or "false"`);
  }

  return raw === "true";
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
  // The deferred Slovak document walk. Off unless a deployment turns it
  // on: it is the only loop here that fetches from a publisher outside
  // the adapter crawl, so starting it is a decision about outbound load,
  // made where it can be reverted without a build.
  skDocumentBackfillEnabled: readBooleanEnv({
    name: "SK_DOCUMENT_BACKFILL_ENABLED",
    fallback: false,
  }),
  // Gap between two document fetches, and therefore the entire
  // throughput of that walk. 500ms is what the crawl has always paced
  // itself at; it is a manners default, not a rate the publisher has
  // confirmed, so it is configurable and should be moved in steps while
  // the walk's failure tallies are watched. The floor keeps a typo from
  // turning the walk into a stampede.
  skDocumentFetchDelayMs: readIntegerEnv({
    name: "SK_DOCUMENT_FETCH_DELAY_MS",
    fallback: 500,
    min: 100,
  }),
  // The standing listing reconciliation. On by default: a source drifting
  // away from what its publisher lists is the failure this exists to prevent,
  // and a check that has to be switched on is a check that is off when it
  // matters. The flag is a kill switch, not an opt-in.
  caseLawReconciliationEnabled: readBooleanEnv({
    name: "CASE_LAW_RECONCILIATION_ENABLED",
    fallback: true,
  }),
  // Gap between two document fetches inside a reconciliation unit, and
  // therefore the whole throughput of the hunt. A manners default rather than
  // a rate any publisher has confirmed; move it in steps while the loop's
  // failure tallies are watched. The floor keeps a typo from turning the
  // hunt into a stampede.
  reconciliationFetchDelayMs: readIntegerEnv({
    name: "RECONCILIATION_FETCH_DELAY_MS",
    fallback: 250,
    min: 100,
  }),
  // The standing citation-resolution walk. On by default, for the same reason
  // reconciliation is: a citator that trails its corpus is the failure this
  // exists to prevent, and a walk that has to be switched on is off when it
  // matters. The flag is a kill switch, not an opt-in — it exists so a
  // database under pressure can be given room without a build.
  caseLawCitationResolutionEnabled: readBooleanEnv({
    name: "CASE_LAW_CITATION_RESOLUTION_ENABLED",
    fallback: true,
  }),
  // Rows examined per statement. The bound on one batch's cost: candidate
  // lookups are one indexed probe each, so this is how much work a single
  // statement asks of the database at once.
  citationResolutionBatchSize: readIntegerEnv({
    name: "CITATION_RESOLUTION_BATCH_SIZE",
    fallback: 2000,
    min: 1,
  }),
  // Gap between two batches, and therefore the whole throughput of the walk.
  // The knob to turn when the corpus database is busy serving readers: at the
  // default batch size this paces the walk at roughly two thousand citations a
  // second's worth of work per second, which a burn-down can be slowed from
  // without a deployment.
  citationResolutionBatchDelayMs: readIntegerEnv({
    name: "CITATION_RESOLUTION_BATCH_DELAY_MS",
    fallback: 1000,
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
