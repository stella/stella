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

/**
 * A data repair that a schema migration left to the online phase.
 *
 * `repair` runs on the migrate entrypoint under the online-migrations lock,
 * with no statement budget on the session; it owns its own transactions and
 * their budgets, and must converge: every call brings the database closer to
 * `assertComplete` passing, an interrupted call is resumed by calling again,
 * and a call on a completed database changes nothing. `assertComplete` is a
 * catalog read the API runs at startup; it never repairs.
 */
export type OnlineRepair = {
  name: string;
  repair: (connection: OnlineMigrationConnection) => Promise<void>;
  assertComplete: (connection: OnlineMigrationConnection) => Promise<void>;
};
