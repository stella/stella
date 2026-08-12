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

type QueryCounter = {
  count: number;
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
 * callbacks (Elysia's hooks), but it mutates the ambient async context frame
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
): TResult => {
  const counter: QueryCounter = { count: 0 };
  return queryCounterStore.run(counter, () => fn(counter));
};

/** Current active store's query count, or `undefined` when no store is active. */
export const currentQueryCount = (): number | undefined =>
  queryCounterStore.getStore()?.count;

/**
 * Drizzle-compatible logger that increments the active store's count per query.
 * When no store is active it does nothing, preserving behavior for background
 * jobs and boot-time queries. Wire this into `drizzle({ logger })` outside
 * production only.
 */
export const queryCountLogger: Logger = {
  logQuery: (): void => {
    const counter = queryCounterStore.getStore();
    if (!counter) {
      return;
    }
    counter.count += 1;
  },
};
