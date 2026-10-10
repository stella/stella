import { panic } from "better-result";

/**
 * The connection the online phase of a migration runs on, and the shape of a
 * data repair registered with it. Separate from `online-migrations.ts` so a
 * repair module can name these without importing the registry that names it.
 */

/**
 * A bound parameter. Scalars only: the migrate entrypoint binds through Bun
 * SQL's `unsafe`, which sends a JavaScript array as comma-joined text rather
 * than a PostgreSQL array, while the test database accepts it, so an array
 * parameter would pass every test and fail the deploy. Bind a list as one
 * joined string and split it in SQL (`string_to_array($1, ',')::uuid[]`).
 */
export type OnlineMigrationParam =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null;

const isOnlineMigrationParam = (
  value: unknown,
): value is OnlineMigrationParam =>
  value === null ||
  value instanceof Date ||
  ["string", "number", "bigint", "boolean"].includes(typeof value);

/**
 * Parameters a query builder rendered, checked for the one shape the
 * migrate connection cannot bind: an array (or any other object) fails here,
 * in tests and deploys alike, instead of reaching the driver.
 */
export const onlineMigrationParams = (
  params: readonly unknown[],
): OnlineMigrationParam[] =>
  params.map((param, index) =>
    isOnlineMigrationParam(param)
      ? param
      : panic(
          `Online migration parameter ${String(index + 1)} is not a scalar; bind lists as a joined string`,
        ),
  );

export type OnlineMigrationConnection = {
  execute: (
    query: string,
    params?: readonly OnlineMigrationParam[],
  ) => Promise<void>;
  query: (
    query: string,
    params?: readonly OnlineMigrationParam[],
  ) => Promise<readonly unknown[]>;
  release: () => void | Promise<void>;
  /** Closes this physical session immediately, including an active statement. */
  terminate?: () => Promise<void>;
};

export type OnlineMigrationPool = {
  reserve: () => Promise<OnlineMigrationConnection>;
};

/** Whether a repair's postcondition already holds, and why it does not. */
export type OnlineRepairCompletion =
  | { cause?: unknown; reason: string; type: "incomplete" }
  | {
      type: "pending";
      reason: string;
      cursor: string | null;
      holdUntil: number | null;
      heldSince: number | null;
    }
  | { type: "complete" };

/**
 * A data repair that a schema migration left to the online phase.
 *
 * `repair` runs on the migrate entrypoint under the online-migrations lock,
 * with no statement budget on the session; it owns its own transactions and
 * their budgets, and must converge: every call brings the database closer to
 * `readCompletion` reporting `complete`, an interrupted call is resumed by
 * calling again, and a call on a completed database changes nothing.
 *
 * `readCompletion` never repairs. The phase reads it before the repair, and
 * runs no walk when the postcondition already holds, so the fixed point costs
 * one read rather than a pass over the table. A durable pending backfill is
 * resumable and may pass deploy/startup; an unattempted incomplete repair
 * still refuses those gates.
 */
export type OnlineRepair = {
  name: string;
  readCompletion: (
    connection: OnlineMigrationConnection,
  ) => Promise<OnlineRepairCompletion>;
  repair: (connection: OnlineMigrationConnection) => Promise<void>;
};
