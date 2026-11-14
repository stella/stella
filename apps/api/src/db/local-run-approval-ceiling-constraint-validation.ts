import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/** The check migration 20261108120000_local_run_max_approval_mode adds NOT VALID. */
export const LOCAL_RUN_APPROVAL_CEILING_CONSTRAINTS = [
  {
    tableName: "organization_settings",
    constraintName: "organization_settings_local_run_max_approval_mode_check",
    introducedBy: "20261108120000_local_run_max_approval_mode",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const LOCAL_RUN_APPROVAL_CEILING_CONSTRAINT_VALIDATIONS =
  LOCAL_RUN_APPROVAL_CEILING_CONSTRAINTS.map(
    (constraint) =>
      ({
        name: constraint.constraintName,
        introducedBy: constraint.introducedBy,
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
      }) satisfies OnlineRepair,
  );
