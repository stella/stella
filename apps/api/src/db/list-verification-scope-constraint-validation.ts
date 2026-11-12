import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "legal_list_verification_runs";
const CONSTRAINT_NAME = "legal_list_verification_runs_scope_check";

/**
 * The run scope check migration
 * 20261112033718_legal_list_verification_run_scope adds NOT VALID. It only
 * constrains the column that migration adds, so existing rows already pass.
 */
export const LIST_VERIFICATION_SCOPE_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

export const LIST_VERIFICATION_SCOPE_CONSTRAINT_VALIDATION = {
  introducedBy: "20261112033718_legal_list_verification_run_scope",
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
      constraints: LIST_VERIFICATION_SCOPE_CONSTRAINTS,
    }),
} satisfies OnlineRepair;
