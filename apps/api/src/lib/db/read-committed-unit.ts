import { panic } from "better-result";

import { isRecord } from "../type-guards";

/** The statement that opens every backfill unit's transaction. */
export const READ_COMMITTED_BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";

/**
 * Confirms a unit's transaction runs in read committed. A BEGIN issued
 * inside a transaction that is already open is ignored, so the explicit
 * isolation on BEGIN alone cannot prove it; gated tables refuse updates in
 * any other isolation.
 */
export const assertReadCommittedUnit = async (
  query: (statement: string) => Promise<readonly unknown[]>,
) => {
  const row = (
    await query("SELECT current_setting('transaction_isolation') AS isolation")
  ).at(0);
  const isolation = isRecord(row) ? row["isolation"] : undefined;
  if (isolation !== "read committed") {
    panic(
      `Backfill unit runs in ${String(isolation)}, not read committed: it started inside an open transaction or under another isolation`,
    );
  }
};
