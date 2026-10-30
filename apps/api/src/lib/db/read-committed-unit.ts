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
 * any other isolation.
 */
const checkReadCommittedUnit = async (
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

type ReadCommittedSession = {
  execute: (statement: string) => Promise<unknown>;
  query: (statement: string) => Promise<readonly unknown[]>;
};

/**
 * Runs `work` as one read committed transaction on `session`. The isolation
 * check, the work and COMMIT share one failure path, so any of them failing
 * rolls back instead of leaving the session in an open or aborted transaction.
 */
export const runReadCommittedUnit = async <T>(
  session: ReadCommittedSession,
  work: () => Promise<T>,
): Promise<Result<Awaited<T>, unknown>> => {
  await session.execute(READ_COMMITTED_BEGIN);
  const unit = (
    await Result.tryPromise({
      try: async () => {
        const isolation = await checkReadCommittedUnit(
          async (statement) => await session.query(statement),
        );
        if (isolation.isErr()) {
          return Result.err(isolation.error);
        }
        const value = await work();
        await session.execute("COMMIT");
        return Result.ok(value);
      },
      catch: (cause: unknown) => cause,
    })
  ).andThen((outcome) => outcome);
  if (unit.isErr()) {
    await session.execute("ROLLBACK");
  }
  return unit;
};
