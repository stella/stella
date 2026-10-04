import { readConstraintCompletion } from "./online-constraint-completion";
import type { OnlineRepair } from "./online-migration-connection";

const CONSTRAINTS = [
  {
    tableName: "contacts",
    constraintName: "contacts_sanctions_monitoring_mode_check",
  },
  {
    tableName: "organization_settings",
    constraintName: "organization_settings_sanctions_monitoring_mode_check",
  },
] as const;

// Defaults satisfy both checks; validate outside the schema transaction so the
// scan holds no additive DDL lock. Catalog completion makes retries converge.
export const SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS = CONSTRAINTS.map(
  ({ tableName, constraintName }) =>
    ({
      name: constraintName,
      readCompletion: async (connection) =>
        await readConstraintCompletion({
          connection,
          tableName,
          constraintName,
          repairName: constraintName,
        }),
      repair: async (connection) => {
        await connection.execute(
          `ALTER TABLE public."${tableName}" VALIDATE CONSTRAINT "${constraintName}"`,
        );
      },
    }) satisfies OnlineRepair,
);
