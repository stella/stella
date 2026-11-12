import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "desktop_runner_runs";
const CONSTRAINT_NAME = "desktop_runner_runs_background_tasks_check";

/**
 * The background task count check migration
 * 20261112220500_desktop_runner_background_tasks adds NOT VALID. It only
 * constrains the column that migration adds with a default of 0, so every
 * existing row already passes.
 */
export const DESKTOP_RUNNER_BACKGROUND_TASKS_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

export const DESKTOP_RUNNER_BACKGROUND_TASKS_CONSTRAINT_VALIDATION = {
  introducedBy: "20261112220500_desktop_runner_background_tasks",
  name: CONSTRAINT_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: TABLE_NAME,
      constraintName: CONSTRAINT_NAME,
      repairName: CONSTRAINT_NAME,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: DESKTOP_RUNNER_BACKGROUND_TASKS_CONSTRAINTS,
    }),
} satisfies OnlineRepair;
