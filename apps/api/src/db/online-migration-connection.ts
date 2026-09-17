/**
 * The connection the online phase of a migration runs on, and the shape of a
 * data repair registered with it. Separate from `online-migrations.ts` so a
 * repair module can name these without importing the registry that names it.
 */

export type OnlineMigrationConnection = {
  execute: (query: string, params?: readonly unknown[]) => Promise<void>;
  query: (
    query: string,
    params?: readonly unknown[],
  ) => Promise<readonly unknown[]>;
  release: () => void;
};

export type OnlineMigrationPool = {
  reserve: () => Promise<OnlineMigrationConnection>;
};

/** Whether a repair's postcondition already holds, and why it does not. */
export type OnlineRepairCompletion =
  | { cause?: unknown; reason: string; type: "incomplete" }
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
 * one read rather than a pass over the table; it is also what the phase and
 * the API's startup gate refuse on, so skipping and asserting cannot drift.
 */
export type OnlineRepair = {
  name: string;
  readCompletion: (
    connection: OnlineMigrationConnection,
  ) => Promise<OnlineRepairCompletion>;
  repair: (connection: OnlineMigrationConnection) => Promise<void>;
};
