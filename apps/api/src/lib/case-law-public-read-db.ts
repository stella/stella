import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { rootDb } from "@/api/db/root";

const CASE_LAW_PUBLIC_READ_DB = Symbol("caseLawPublicReadDb");

type CaseLawQueryKey = Extract<keyof Transaction["query"], `caseLaw${string}`>;

export type CaseLawPublicReadTransaction = Pick<
  Transaction,
  "execute" | "select"
> & {
  query: Pick<Transaction["query"], CaseLawQueryKey>;
};

export type CaseLawPublicReadDb = (<T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
) => Promise<T>) & {
  [CASE_LAW_PUBLIC_READ_DB]: true;
};

/**
 * Read-only access boundary for public case-law data.
 *
 * Public handlers intentionally do not receive `scopedDb`, `session`, or
 * workspace context. Requiring this branded wrapper keeps public reads from
 * accidentally depending on authenticated route macros.
 */
export const caseLawPublicReadDb: CaseLawPublicReadDb = Object.assign(
  async <T>(fn: (tx: CaseLawPublicReadTransaction) => Promise<T>): Promise<T> =>
    await rootDb.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);

      return await fn(tx);
    }),
  { [CASE_LAW_PUBLIC_READ_DB]: true as const },
);
