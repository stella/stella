/**
 * The shape of the provision state backfill's steps, apart from the steps
 * themselves so a step module can name it without importing the runner.
 */

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
  advance: (connection: ProvisionBackfillSession) => Promise<void>;
};
