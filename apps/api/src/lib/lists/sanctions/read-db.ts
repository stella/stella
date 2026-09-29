import { sql } from "drizzle-orm";

import { stellaPublicSanctionsReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import type { RlsDatabase } from "@/api/db/scoped";

export type SanctionsReadTransaction = Pick<Transaction, "select" | "execute">;

/** Screening needs only global reference-data reads, including for signed-in callers. */
export type SanctionsReadDb = <T>(
  fn: (tx: SanctionsReadTransaction) => Promise<T>,
) => Promise<T>;

const PUBLIC_SANCTIONS_READ_DB = Symbol("sanctionsPublicReadDb");
export type SanctionsPublicReadDb = SanctionsReadDb & {
  [PUBLIC_SANCTIONS_READ_DB]: true;
};
const PUBLIC_SANCTIONS_STATEMENT_TIMEOUT = "10s";

/** The role has no tenant grants; a read-only transaction also prevents SQL writes. */
export const createSanctionsPublicReadDb = <
  TTransaction extends SanctionsReadTransaction,
>(
  database: RlsDatabase<TTransaction>,
): SanctionsPublicReadDb =>
  Object.assign(
    async <T>(fn: (tx: SanctionsReadTransaction) => Promise<T>): Promise<T> =>
      await database.transaction(async (tx) => {
        await tx.execute(sql`SELECT
        set_config('role', ${stellaPublicSanctionsReader.name}, true),
        set_config('transaction_read_only', 'on', true),
        set_config('statement_timeout', ${PUBLIC_SANCTIONS_STATEMENT_TIMEOUT}, true)`);
        return await fn(tx);
      }),
    { [PUBLIC_SANCTIONS_READ_DB]: true as const },
  );
