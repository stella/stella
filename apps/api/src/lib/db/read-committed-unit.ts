import { Result, TaggedError } from "better-result";

import { isRecord } from "../type-guards";

/** The statement that opens every backfill unit's transaction. */
export const READ_COMMITTED_BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";

export class ReadCommittedUnitError extends TaggedError(
  "ReadCommittedUnitError",
)<{
  message: string;
  isolation: string;
}> {}

/**
 * Confirms a unit's transaction runs in read committed. A BEGIN issued
 * inside a transaction that is already open is ignored, so the explicit
 * isolation on BEGIN alone cannot prove it; gated tables refuse updates in
 * any other isolation. The caller rolls back on an error.
 */
export const checkReadCommittedUnit = async (
  query: (statement: string) => Promise<readonly unknown[]>,
): Promise<Result<void, ReadCommittedUnitError>> => {
  const row = (
    await query("SELECT current_setting('transaction_isolation') AS isolation")
  ).at(0);
  const isolation = isRecord(row) ? String(row["isolation"]) : "unknown";
  return isolation === "read committed"
    ? Result.ok(undefined)
    : Result.err(
        new ReadCommittedUnitError({
          message: `Backfill unit runs in ${isolation}, not read committed: it started inside an open transaction or under another isolation`,
          isolation,
        }),
      );
};
