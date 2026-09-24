import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";

/**
 * The door through which an operator script outside the case-law tables
 * reaches the database; case-law scripts use `lib/case-law/maintenance-lane.ts`.
 *
 * A script does not import the root connection; it opens one of these after
 * parsing its arguments. A dry run opens it read-only, so every statement runs
 * in a `READ ONLY` transaction and a step that would write fails with SQLSTATE
 * 25006 at its first statement instead of quietly applying.
 */
type ExecuteResult<TRow extends Record<string, unknown>> = Awaited<
  ReturnType<typeof rootDb.execute<TRow>>
>;

export type OperatorScriptDb = {
  execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: SQLWrapper | string,
  ) => Promise<ExecuteResult<TRow>>;
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
};

export const openOperatorScriptDb = ({
  readOnly,
}: {
  readOnly: boolean;
}): OperatorScriptDb => {
  const transaction = async <T>(fn: (tx: Transaction) => Promise<T>) =>
    await rootDb.transaction(async (tx) => {
      if (readOnly) {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
      }
      return await fn(tx);
    });
  return {
    execute: async <
      TRow extends Record<string, unknown> = Record<string, unknown>,
    >(
      query: SQLWrapper | string,
    ) => await transaction(async (tx) => await tx.execute<TRow>(query)),
    transaction,
  };
};
