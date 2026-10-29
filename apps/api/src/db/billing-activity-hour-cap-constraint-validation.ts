import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/** Constraints added without scanning existing billing rows. */
export const BILLING_ACTIVITY_HOUR_CAP_CONSTRAINTS = [
  {
    tableName: "rate_entries",
    constraintName: "rate_entries_activity_code_id_billing_codes_id_fk",
  },
  {
    tableName: "billing_arrangements",
    constraintName: "billing_arrangements_mode_caps_check",
  },
  {
    tableName: "billing_arrangements",
    constraintName: "billing_arrangements_minute_crossing_check",
  },
] as const satisfies readonly OnlineConstraintValidation[];

export const BILLING_ACTIVITY_HOUR_CAP_CONSTRAINT_VALIDATIONS =
  BILLING_ACTIVITY_HOUR_CAP_CONSTRAINTS.map(
    (constraint) =>
      ({
        name: constraint.constraintName,
        readCompletion: async (connection) =>
          await readConstraintCompletion({
            connection,
            tableName: constraint.tableName,
            constraintName: constraint.constraintName,
            repairName: constraint.constraintName,
          }),
        repair: async (connection, tables) =>
          await validateOnlineConstraints({
            connection,
            tables,
            constraints: [constraint],
          }),
      } as const) satisfies OnlineRepair,
  );
