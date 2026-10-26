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

export type QueryCounter = {
  count: number;
  transactions: number;
  fingerprints: Map<string, number>;
  detectRepeatedQueries: boolean;
  countTransactions: boolean;
  diagnostics: boolean;
  parent: QueryCounter | undefined;
  onQuery?: (phase: "work" | "cleanup") => void;
};

const queryCounterStore = new AsyncLocalStorage<QueryCounter>();

/**
 * Run `fn` inside a fresh counter store. Every query logged through
 * {@link queryCountLogger} while `fn` (and its awaited continuations) run
 * increments this store and its enclosing counters. Interleaved sibling
 * contexts remain independent.
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
    diagnostics: false,
    parent: queryCounterStore.getStore(),
  };
  return queryCounterStore.run(counter, () => fn(counter));
};

export const currentQueryCounter = () => queryCounterStore.getStore();

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

const recordTransactionRoundTrip = (
  phase: "work" | "cleanup" = "work",
): void => {
  let counter = queryCounterStore.getStore();
  const updated: QueryCounter[] = [];
  while (counter !== undefined) {
    if (counter.countTransactions) {
      counter.transactions += 1;
      updated.push(counter);
    }
    counter = counter.parent;
  }
  for (const store of updated) {
    store.onQuery?.(phase);
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
  if (!counter?.detectRepeatedQueries) {
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

const sqlControlType = (
  query: string,
): "savepoint" | "transaction" | undefined => {
  if (
    /^\s*(?:savepoint|release)\b|^\s*rollback\s+(?:(?:work|transaction)\s+)?to\b/iu.test(
      query,
    )
  ) {
    return "savepoint";
  }
  if (/^\s*(begin|commit|rollback)\b/iu.test(query)) {
    return "transaction";
  }
  return undefined;
};

/**
 * Drizzle-compatible logger that increments the active store's count per query.
 * When no store is active it does nothing, preserving behavior for background
 * jobs and boot-time queries. Wire this into `drizzle({ logger })` outside
 * production only.
 */
const recordSqlQuery = (query: string, phase: "work" | "cleanup"): void => {
  let counter = queryCounterStore.getStore();
  if (!counter) {
    return;
  }
  if (sqlControlType(query) !== undefined) {
    return;
  }
  // Reuse the repeated-query owner's normalization and callsite identity.
  // Session setup contributes to the count, never to repeated-work findings.
  let fingerprint: string | undefined;
  const sessionConfiguration = isSessionConfigurationQuery(query);
  const updated: QueryCounter[] = [];
  while (counter !== undefined) {
    counter.count += 1;
    if (
      !sessionConfiguration &&
      (counter.detectRepeatedQueries || counter.diagnostics)
    ) {
      fingerprint ??= `${queryCallsite()} :: ${normalizeSql(query)}`;
      counter.fingerprints.set(
        fingerprint,
        (counter.fingerprints.get(fingerprint) ?? 0) + 1,
      );
    }
    updated.push(counter);
    counter = counter.parent;
  }
  for (const store of updated) {
    store.onQuery?.(phase);
  }
};

export const queryCountLogger: Logger = {
  logQuery: (query) => recordSqlQuery(query, "work"),
};

type NativeQueryState = { phase: "created" | "started" };
const instrumentedSessions = new WeakSet<object>();
const countedQueries = new WeakSet<object>();

const isNativeQuery = (
  value: unknown,
): value is object & {
  then: (...args: unknown[]) => unknown;
  execute: () => unknown;
} =>
  value !== null &&
  typeof value === "object" &&
  "then" in value &&
  typeof value.then === "function" &&
  "execute" in value &&
  typeof value.execute === "function";

const isSqlSession = (value: unknown): value is object =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  "unsafe" in value &&
  typeof value.unsafe === "function";

const QUERY_START_METHODS = new Set([
  "then",
  "catch",
  "finally",
  "execute",
  "run",
  "readable",
  "writable",
]);
const TRANSACTION_METHODS = new Set([
  "begin",
  "transaction",
  "savepoint",
  "beginDistributed",
  "distributed",
]);

const instrumentNativeQuery = (
  query: object,
  statement: string,
  phase: "work" | "cleanup",
): object => {
  if (countedQueries.has(query)) {
    return query;
  }
  const state: NativeQueryState = { phase: "created" };
  for (const method of QUERY_START_METHODS) {
    const original: unknown = Reflect.get(query, method, query);
    if (typeof original !== "function") {
      continue;
    }
    // Keep Bun's actual Query object for SQL fragments, private methods and
    // native Promise identity. Only the lazy start methods gain an observer.
    Object.defineProperty(query, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        if (state.phase === "created") {
          if (Reflect.get(query, "cancelled", query) !== true) {
            const controlType = sqlControlType(statement);
            if (controlType === "transaction") {
              const controlPhase = /^\s*(commit|rollback)\b/iu.test(statement)
                ? "cleanup"
                : phase;
              recordTransactionRoundTrip(controlPhase);
            } else if (controlType === undefined) {
              recordSqlQuery(statement, phase);
            }
          }
          state.phase = "started";
        }
        const result: unknown = Reflect.apply(original, query, args);
        return result;
      },
    });
  }
  countedQueries.add(query);
  return query;
};

/**
 * Instrument the dedicated transport once, below Drizzle and raw callers.
 * Its lazy queries count only when started; modifiers share that one start.
 * Do not also install queryCountLogger on a database over this transport.
 */
export const instrumentDedicatedSqlCounts = <TClient extends object>(
  client: TClient,
  phase: "work" | "cleanup" = "work",
): TClient => {
  if (instrumentedSessions.has(client)) {
    return client;
  }
  const proxy = new Proxy(client, {
    apply(target, _receiver, args: unknown[]) {
      if (typeof target !== "function") {
        return panic("Expected a callable SQL session");
      }
      const result: unknown = Reflect.apply(target, target, args);
      if (!isNativeQuery(result)) {
        return result;
      }
      const literals: unknown = args.at(0);
      // SQL(name) creates a non-executable identifier Query; Bun must receive
      // that actual object when the enclosing tagged statement is assembled.
      if (typeof literals === "string") {
        return result;
      }
      if (
        !Array.isArray(literals) ||
        !literals.every((part) => typeof part === "string")
      ) {
        return panic("Expected SQL template literals for a native query");
      }
      // Parameters never enter diagnostics; the existing fingerprint owner
      // normalizes this statement exactly as it does Drizzle queries.
      return instrumentNativeQuery(result, literals.join(" ? "), phase);
    },
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "bind" || property === "call" || property === "apply") {
        // Function invocation must keep the instrumented callable receiver.
        const bound: unknown = value.bind(proxy);
        return bound;
      }
      if (property === "reserve" || property === "connect") {
        return async (...args: unknown[]) => {
          const reserved: unknown = await Reflect.apply(value, target, args);
          if (!isSqlSession(reserved)) {
            return panic("Expected a reserved SQL session");
          }
          return instrumentDedicatedSqlCounts(reserved, phase);
        };
      }
      if (typeof property === "string" && TRANSACTION_METHODS.has(property)) {
        return async (...args: unknown[]) => {
          const callback: unknown = args.at(-1);
          if (typeof callback !== "function") {
            return panic("A SQL transaction needs a callback");
          }
          const runInCaller = AsyncLocalStorage.snapshot();
          const wrapped = (session: unknown) => {
            if (!isSqlSession(session)) {
              return panic("Expected a SQL transaction session");
            }
            return runInCaller(() => {
              const result: unknown = Reflect.apply(callback, undefined, [
                instrumentDedicatedSqlCounts(session, phase),
              ]);
              return result;
            });
          };
          const operation = async () => {
            const result: unknown = await Reflect.apply(value, target, [
              ...args.slice(0, -1),
              wrapped,
            ]);
            return result;
          };
          return property === "savepoint"
            ? await operation()
            : await runCountedTransaction(operation);
        };
      }
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        if (!isNativeQuery(result)) {
          return result;
        }
        const statement: unknown = args.at(0);
        if (property === "file") {
          return instrumentNativeQuery(result, "<SQL file>", phase);
        }
        if (typeof statement !== "string") {
          return panic("Expected SQL text for a native query");
        }
        return instrumentNativeQuery(result, statement, phase);
      };
    },
  });
  instrumentedSessions.add(proxy);
  return proxy;
};
