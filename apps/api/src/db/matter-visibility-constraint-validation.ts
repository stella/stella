import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The matter visibility check the visibility migration adds NOT VALID; the
 * online phase validates it through the contention gate. Every row written
 * before the migration holds null, which the check admits.
 */
export const MATTER_VISIBILITY_CONSTRAINT = {
  tableName: "workspaces",
  constraintName: "workspaces_visibility_check",
  introducedBy: "20261124200000_matter_visibility",
} as const satisfies OnlineConstraintValidation & { introducedBy: string };

export const MATTER_VISIBILITY_CONSTRAINT_VALIDATION = {
  name: MATTER_VISIBILITY_CONSTRAINT.constraintName,
  introducedBy: MATTER_VISIBILITY_CONSTRAINT.introducedBy,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: MATTER_VISIBILITY_CONSTRAINT.tableName,
      constraintName: MATTER_VISIBILITY_CONSTRAINT.constraintName,
      repairName: MATTER_VISIBILITY_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [MATTER_VISIBILITY_CONSTRAINT],
    }),
} satisfies OnlineRepair;
