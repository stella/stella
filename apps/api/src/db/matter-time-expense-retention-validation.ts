import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/** Matter references migration 20261027120000_matter_time_expense_retention adds NOT VALID. */
export const MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS = [
  {
    tableName: "time_entries",
    constraintName: "time_entries_workspace_id_workspaces_id_fkey",
    introducedBy: "20261027120000_matter_time_expense_retention",
  },
  {
    tableName: "time_entries",
    constraintName: "time_entries_workspace_organization_fk",
    introducedBy: "20261027120000_matter_time_expense_retention",
  },
  {
    tableName: "expenses",
    constraintName: "expenses_workspace_id_workspaces_id_fkey",
    introducedBy: "20261027120000_matter_time_expense_retention",
  },
  {
    tableName: "expenses",
    constraintName: "expenses_workspace_organization_fk",
    introducedBy: "20261027120000_matter_time_expense_retention",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const MATTER_TIME_EXPENSE_RETENTION_VALIDATIONS =
  MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS.map(
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
