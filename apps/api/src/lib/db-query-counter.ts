import { panic, TaggedError } from "better-result";
import type { SQL } from "bun";
import type { Logger } from "drizzle-orm";
// Per-request database query counter.
//
// An AsyncLocalStorage-backed counter that lets the HTTP layer report how many
// SQL statements a single request issued, so N+1 patterns become observable per
// route (an e2e guard asserts per-route budgets from the `x-db-queries`
// response header this feeds).
//
// The module is deliberately side-effect free and framework-agnostic: it only
// creates an ALS instance and pure helpers. Nothing here reads env or touches
// the database, so it is safe to import from shared modules (see the
// "Module Side Effects" rules in AGENTS.md). Callers decide when to activate a
// store; the Drizzle logger is a no-op whenever no store is active (background
// jobs, boot-time queries), so wiring it in costs nothing beyond an ALS lookup
// on those paths. Deployed environments wire no logger at all.
import { AsyncLocalStorage } from "node:async_hooks";

/** Response header carrying the per-request query count outside production. */
export const DB_QUERY_COUNT_HEADER = "x-db-queries";
export const DB_TRANSACTION_COUNT_HEADER = "x-db-transactions";

type QueryCounter = {
  count: number;
  transactions: number;
  fingerprints: Map<string, number>;
  detectRepeatedQueries: boolean;
  countTransactions: boolean;
};

const queryCounterStore = new AsyncLocalStorage<QueryCounter>();

/**
 * Run `fn` inside a fresh counter store. Every query logged through
 * {@link queryCountLogger} while `fn` (and its awaited continuations) run
 * increments this store and no other, so interleaved async contexts count
 * independently.
 *
 * This is the only supported way to open a store. `AsyncLocalStorage.enterWith`
 * would be the convenient alternative for a lifecycle split across separate
 * callbacks (request hooks), but it mutates the ambient async context frame
 * without a restore point: the runtime leaves that frame current for callbacks
 * it dispatches afterwards, so a background timer or worker loop that resumes
 * while a request's frame is current adopts that request's store and bills its
 * own queries to that request's `x-db-queries` count — for as long as the loop
 * lives. `run` restores the previous frame when `fn` returns, so nothing
 * outside the callback tree can join the store. The HTTP layer therefore wraps
 * the composed request handler (see `server.ts`) rather than opening a store
 * from a hook.
 */
export const runWithQueryCounter = <TResult>(
  fn: (counter: Readonly<QueryCounter>) => TResult,
  {
    detectRepeatedQueries = false,
    countTransactions = true,
  }: { detectRepeatedQueries?: boolean; countTransactions?: boolean } = {},
): TResult => {
  const counter: QueryCounter = {
    count: 0,
    transactions: 0,
    fingerprints: new Map(),
    detectRepeatedQueries,
    countTransactions,
  };
  return queryCounterStore.run(counter, () => fn(counter));
};

export class RepeatedQueryFingerprintError extends TaggedError(
  "RepeatedQueryFingerprintError",
)<{ message: string; fingerprints: readonly string[] }> {}

export const runWithMeasuredQueryCounter = async <TResult>(
  fn: (counter: Readonly<QueryCounter>) => Promise<TResult>,
  ledger: readonly { id: string; count: number }[] = [],
): Promise<TResult> =>
  await runWithQueryCounter(
    async (counter) => {
      const result = await fn(counter);
      const allowed = new Map(ledger.map(({ id, count }) => [id, count]));
      const fingerprints = [...counter.fingerprints]
        .filter(
          ([fingerprint, count]) =>
            count > 1 && count > (allowed.get(fingerprint) ?? 0),
        )
        .map(([fingerprint]) => fingerprint);
      if (fingerprints.length > 0) {
        panic(
          "Measured request exceeded its repeated SQL callsite budget",
          new RepeatedQueryFingerprintError({
            message: `Repeated SQL callsites detected: ${fingerprints.join("; ")}`,
            fingerprints,
          }),
        );
      }
      return result;
    },
    { detectRepeatedQueries: true, countTransactions: true },
  );

/** Current active store's query count, or `undefined` when no store is active. */
export const currentQueryCount = (): number | undefined =>
  queryCounterStore.getStore()?.count;

export const currentTransactionCount = (): number | undefined =>
  queryCounterStore.getStore()?.transactions;

const recordTransactionRoundTrip = (): void => {
  const counter = queryCounterStore.getStore();
  if (counter?.countTransactions) {
    counter.transactions += 1;
  }
};

export const runCountedTransaction = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  recordTransactionRoundTrip();
  try {
    return await operation();
  } finally {
    recordTransactionRoundTrip();
  }
};

export const instrumentSqlTransactionCounts = (client: SQL): SQL => {
  const begin = client.begin.bind(client);
  const countedBegin = async <const T>(
    optionsOrCallback: string | SQL.TransactionContextCallback<T>,
    callback?: SQL.TransactionContextCallback<T>,
  ): Promise<SQL.ContextCallbackResult<T>> =>
    await runCountedTransaction(async () => {
      if (typeof optionsOrCallback !== "string") {
        return await begin(optionsOrCallback);
      }
      if (callback === undefined) {
        return panic("begin(options) needs a transaction callback");
      }
      return await begin(optionsOrCallback, callback);
    });
  Object.defineProperty(client, "begin", {
    configurable: true,
    value: countedBegin,
  });
  Object.defineProperty(client, "transaction", {
    configurable: true,
    value: countedBegin,
  });
  return client;
};

export const currentRepeatedQueryFingerprints = (): readonly string[] => {
  const counter = queryCounterStore.getStore();
  if (!counter) {
    return [];
  }
  return [...counter.fingerprints]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
};

const normalizeSql = (query: string): string =>
  query
    .replace(/\$\d+|\?/gu, "?")
    .replace(/\b\d+(?:\.\d+)?\b/gu, "?")
    .replace(/'([^']|'')*'/gu, "?")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

const queryCallsite = (): string => {
  const frame = new Error("SQL query fingerprint callsite capture").stack
    ?.split("\n")
    .find(
      (line) =>
        line.includes(" at ") &&
        !line.includes("db-query-counter.ts") &&
        !line.includes("/node_modules/"),
    );
  return frame?.trim().replaceAll(`${process.cwd()}/`, "") ?? "unknown";
};

const isSessionConfigurationQuery = (query: string): boolean =>
  /^\s*select\s+set_config\s*\(/iu.test(query);

/**
 * Drizzle-compatible logger that increments the active store's count per query.
 * When no store is active it does nothing, preserving behavior for background
 * jobs and boot-time queries. Wire this into `drizzle({ logger })` outside
 * production only.
 */
export const queryCountLogger: Logger = {
  logQuery: (query): void => {
    const counter = queryCounterStore.getStore();
    if (!counter) {
      return;
    }
    if (/^\s*(begin|commit|rollback)\b/iu.test(query)) {
      return;
    }
    counter.count += 1;
    // RLS installs session-local settings for every scoped transaction; their
    // repetition is protocol setup, not per-row query work.
    if (!counter.detectRepeatedQueries || isSessionConfigurationQuery(query)) {
      return;
    }
    const fingerprint = `${queryCallsite()} :: ${normalizeSql(query)}`;
    counter.fingerprints.set(
      fingerprint,
      (counter.fingerprints.get(fingerprint) ?? 0) + 1,
    );
  },
};
