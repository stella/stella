import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { executedRows } from "@/api/lib/db/executed-rows";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type ExecuteOnlyTransaction = {
  execute: (query: SQL) => PromiseLike<unknown>;
};

type PgliteScopedDb = <T>(
  fn: (tx: ExecuteOnlyTransaction) => Promise<T>,
) => Promise<T>;
type PgliteNestedTransaction = (
  run: (nested: ExecuteOnlyTransaction) => Promise<unknown>,
) => Promise<unknown>;

const isPgliteNestedTransaction = (
  value: unknown,
): value is PgliteNestedTransaction => typeof value === "function";

/**
 * A PGlite transaction handle whose `execute` answers rows, as the server
 * driver does, instead of PGlite's `{ rows }` wrapper. Other transaction
 * methods pass through unchanged, and nested transactions use the same adapter.
 */
const adaptTransaction = (tx: ExecuteOnlyTransaction): Transaction =>
  asTestRaw<Transaction>(
    new Proxy(tx, {
      get: (target, property) => {
        if (property === "execute") {
          return async (query: SQL) =>
            executedRows(await target.execute(query));
        }
        const value: unknown = Reflect.get(target, property, target);
        if (property === "transaction" && isPgliteNestedTransaction(value)) {
          return async (run: (nested: Transaction) => Promise<unknown>) => {
            const result: unknown = await value(
              async (nested) => await run(adaptTransaction(nested)),
            );
            return result;
          };
        }
        if (typeof value !== "function") {
          return value;
        }
        return (...args: readonly unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    }),
  );

export const executeRowsScopedDb =
  (scopedDb: PgliteScopedDb): ScopedDb =>
  async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    await scopedDb(async (tx) => await fn(adaptTransaction(tx)));
