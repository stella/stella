/**
 * The shape of the provision state backfill's steps, apart from the steps
 * themselves so a step module can name it without importing the runner.
 */

import { Result, TaggedError } from "better-result";

/**
 * A bound parameter. Scalars only: the scheduler binds through Bun SQL's
 * `unsafe`, which sends a JavaScript array as comma-joined text rather than a
 * PostgreSQL array, while the test database accepts one. Bind a list as one
 * joined string and split it in SQL (`string_to_array($1, ',')::uuid[]`).
 */
type ProvisionBackfillParam = string | number | bigint | boolean | null;

/** One reserved session: a unit's BEGIN, statements and COMMIT share it. */
export type ProvisionBackfillSession = {
  execute: (
    query: string,
    params?: readonly ProvisionBackfillParam[],
  ) => Promise<void>;
  query: (
    query: string,
    params?: readonly ProvisionBackfillParam[],
  ) => Promise<readonly unknown[]>;
  setTransactionBudget: (budget: {
    lockTimeout: number;
    statementTimeout: number;
  }) => Promise<void>;
};

export type ProvisionBackfillCompletion =
  | { reason: string; type: "incomplete" }
  | { type: "complete" };

/**
 * How much of a run one unit may take: a keyset page (many per run, until the
 * run's deadline) or a whole-table scan (alone in its run).
 */
export const PROVISION_BACKFILL_BUDGET = {
  PAGE: "page",
  WHOLE_RUN: "wholeRun",
} as const;

type ProvisionBackfillBudget =
  (typeof PROVISION_BACKFILL_BUDGET)[keyof typeof PROVISION_BACKFILL_BUDGET];

/**
 * One resumable part of the provision state backfill: whether it is done, and
 * one committed unit of progress towards done.
 */
export type ProvisionBackfillStep = {
  name: string;
  budget: ProvisionBackfillBudget;
  readCompletion: (
    connection: ProvisionBackfillSession,
  ) => Promise<ProvisionBackfillCompletion>;
  advance: (
    connection: ProvisionBackfillSession,
  ) => Promise<ProvisionBackfillUnit>;
};

/** A unit that failed and was rolled back; the next run retries it. */
export class ProvisionBackfillUnitError extends TaggedError(
  "ProvisionBackfillUnitError",
)<{
  message: string;
  cause: unknown;
}> {}

export type ProvisionBackfillUnit = Result<void, ProvisionBackfillUnitError>;

type UnitBudget = { lockTimeout: number; statementTimeout: number };

/**
 * Runs `work` as one transaction on the session under `budget`: it commits
 * with its cursor, or rolls back and is returned as the unit's failure.
 */
export const inBackfillTransaction = async (
  session: ProvisionBackfillSession,
  { lockTimeout, statementTimeout }: UnitBudget,
  work: () => Promise<void>,
): Promise<ProvisionBackfillUnit> => {
  await session.execute("BEGIN");
  const unit = await Result.tryPromise({
    try: async () => {
      await session.setTransactionBudget({
        lockTimeout,
        statementTimeout,
      });
      await work();
      await session.execute("COMMIT");
    },
    catch: (cause) =>
      new ProvisionBackfillUnitError({
        message:
          cause instanceof Error
            ? cause.message
            : "a provision backfill unit failed",
        cause,
      }),
  });
  if (unit.isErr()) {
    await session.execute("ROLLBACK");
  }
  return unit;
};
