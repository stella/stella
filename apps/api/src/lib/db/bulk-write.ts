import { chunked } from "@/api/lib/chunked";

/**
 * Rows per statement. PostgreSQL accepts at most 65,535 bind parameters in one
 * statement, so 500 rows leaves room for the widest table any caller writes
 * without the cap becoming a per-table calculation.
 */
const DB_INSERT_BATCH_SIZE = 500;

/**
 * Write a row set whose size has no natural upper bound.
 *
 * A caller that inserts one row per loop iteration pays a round trip per row.
 * The fix is a multi-row insert, but a set with no upper bound cannot be one
 * statement: past the bind-parameter cap PostgreSQL refuses it. So the write is
 * chunked, and chunking means a loop with an await in it. Putting that loop
 * here means it is written and reviewed once, and the batch size is one named
 * constant rather than a number each caller re-derives from its table's width.
 *
 * Note for reviewers: `no-db-await-in-loop` does not fire on the loop below,
 * because what is awaited is a callback parameter rather than a database
 * handle. The rule therefore stops seeing a chunked write once it routes
 * through here — which is the point, but it means this loop is guarded by
 * review rather than by the rule.
 *
 * The writer is passed in rather than the table, so `values()` is still written
 * where the table is statically known and drizzle's inference for the row type
 * is untouched. A generic over the table would need a cast to get there.
 *
 * ```ts
 * await insertInChunks(entityRows, (batch) =>
 *   tx.insert(entities).values(batch),
 * );
 * ```
 *
 * Ordering is the caller's: batches are written in array order, and a failure
 * leaves the batches already written in place unless the caller holds a
 * transaction, which every current caller does.
 */
export const insertInChunks = async <TRow>(
  rows: readonly TRow[],
  write: (batch: TRow[]) => Promise<unknown>,
): Promise<void> => {
  for (const batch of chunked(rows, DB_INSERT_BATCH_SIZE)) {
    await write(batch);
  }
};
