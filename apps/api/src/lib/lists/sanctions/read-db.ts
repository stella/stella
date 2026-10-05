import { Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import { stellaPublicSanctionsReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import type { RlsDatabase } from "@/api/db/scoped";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";

export type SanctionsReadTransaction = Pick<Transaction, "select" | "execute">;

/** Screening needs only global reference-data reads, including for signed-in callers. */
export type SanctionsReadDb = <T>(
  fn: (tx: SanctionsReadTransaction) => Promise<T>,
) => Promise<T>;

const PUBLIC_SANCTIONS_READ_DB = Symbol("sanctionsPublicReadDb");
export type SanctionsPublicReadDb = SanctionsReadDb & {
  [PUBLIC_SANCTIONS_READ_DB]: true;
  validateRole: () => Promise<Result<void, SanctionsPublicRoleError>>;
};
const PUBLIC_SANCTIONS_STATEMENT_TIMEOUT_MS = 10_000;

export class SanctionsPublicRoleError extends TaggedError(
  "SanctionsPublicRoleError",
)<{ message: string }> {}

/** The role has no tenant grants; a read-only transaction also prevents SQL writes. */
export const createSanctionsPublicReadDb = <
  TTransaction extends SanctionsReadTransaction,
>(
  database: RlsDatabase<TTransaction>,
): SanctionsPublicReadDb => {
  const read = async <T>(
    fn: (tx: SanctionsReadTransaction) => T | Promise<T>,
  ): Promise<T> =>
    await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT
        set_config('role', ${stellaPublicSanctionsReader.name}, true),
        set_config('transaction_read_only', 'on', true)`);
      await setSharedStatementTimeout(
        tx,
        PUBLIC_SANCTIONS_STATEMENT_TIMEOUT_MS,
      );
      return await fn(tx);
    });
  let validation: Promise<Result<void, SanctionsPublicRoleError>> | undefined;
  const validateRole = async () => {
    // Probe outside screening: its recoverable list failures must not mask a
    // deployment that cannot assume the anonymous reader role.
    validation ??= Result.tryPromise({
      try: async () => await read(() => undefined),
      catch: () =>
        new SanctionsPublicRoleError({
          message: "Public sanctions database role is unavailable",
        }),
    }).then((result) => {
      if (result.isErr()) {
        validation = undefined;
      }
      return result;
    });
    return await validation;
  };
  return Object.assign(read, {
    [PUBLIC_SANCTIONS_READ_DB]: true as const,
    validateRole,
  });
};
