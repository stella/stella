import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINTS = [
  {
    tableName: "organization_settings",
    constraintName: "organization_settings_ai_instructions_length_check",
  },
] as const satisfies readonly OnlineConstraintValidation[];

// The schema transaction has committed before the online phase starts, so the
// validation scan holds no lock from adding the column and CHECK; the table
// gate bounds its lock wait. Catalog completion makes retries converge.
export const ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINT_VALIDATIONS =
  ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINTS.map(
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
        repair: async (connection, tables) =>
          await validateOnlineConstraints({
            connection,
            tables,
            constraints: [{ tableName, constraintName }],
          }),
      }) satisfies OnlineRepair,
  );
