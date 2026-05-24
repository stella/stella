import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

// Postgres' `SELECT … FOR UPDATE` only locks rows that already exist.
// A cell with no `cell_metadata` row yet cannot be predicate-locked
// at READ COMMITTED, so a manual edit can `INSERT` a locked row
// concurrently with an AI write tx and the AI tx will still clobber
// the manual value. Advisory locks live in shared memory keyed by an
// int4 pair, so both paths serialize even when the underlying row
// doesn't exist.
//
// Callers must hold the locks for the full extent of any
// `cell_metadata` read-then-write sequence; `pg_advisory_xact_lock`
// auto-releases at COMMIT/ROLLBACK.

export const acquireCellLock = async ({
  tx,
  entityVersionId,
  propertyId,
}: {
  tx: Transaction;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
}): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${entityVersionId}), hashtext(${propertyId}))`,
  );
};

export const acquireCellLocks = async ({
  tx,
  entityVersionId,
  propertyIds,
}: {
  tx: Transaction;
  entityVersionId: SafeId<"entityVersion">;
  propertyIds: readonly SafeId<"property">[];
}): Promise<void> => {
  if (propertyIds.length === 0) {
    return;
  }
  // Sort so concurrent callers with overlapping candidate sets
  // acquire locks in the same order; otherwise interleaved batches
  // can deadlock.
  const sorted = [...propertyIds].sort();
  for (const propertyId of sorted) {
    await acquireCellLock({ tx, entityVersionId, propertyId });
  }
};
