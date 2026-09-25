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

/**
 * A PGlite transaction handle whose `execute` answers rows, as the server
 * driver does, instead of PGlite's `{ rows }` wrapper. The handle exposes
 * `execute` alone: it serves readers that issue raw SQL and nothing else.
 */
export const executeRowsScopedDb =
  (scopedDb: PgliteScopedDb): ScopedDb =>
  async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    await scopedDb(
      async (tx) =>
        await fn(
          asTestRaw<Transaction>({
            execute: async (query: SQL) =>
              executedRows(await tx.execute(query)),
          }),
        ),
    );
