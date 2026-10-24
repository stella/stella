import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/** The AI billing draft value checks, added NOT VALID on populated tables. */
export const BILLING_DRAFTS_CONSTRAINTS = [
  {
    tableName: "organization_settings",
    constraintName: "organization_settings_ai_billing_drafts_mode_check",
  },
  {
    tableName: "contacts",
    constraintName: "contacts_time_billing_format_check",
  },
] as const satisfies readonly OnlineConstraintValidation[];

export const BILLING_DRAFTS_CONSTRAINT_VALIDATIONS =
  BILLING_DRAFTS_CONSTRAINTS.map(
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
      }) satisfies OnlineRepair,
  );
