import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * Checks migrations 20261025090100_style_set_deletion_cleanup and
 * 20261025090200_file_comparison_claims add NOT VALID. Rows written before
 * them carry the zero attempt default, a status from the narrower list and no
 * claim, which every check accepts; new rows are checked from the start.
 * Validating here keeps the scan out of the schema transaction.
 */
export const FILE_LIFECYCLE_CONSTRAINTS = [
  {
    tableName: "style_sets",
    constraintName:
      "style_sets_deletion_cleanup_attempt_count_nonnegative_check",
  },
  {
    tableName: "file_comparison_uploads",
    constraintName: "file_comparison_uploads_status_check",
  },
  {
    tableName: "file_comparison_uploads",
    constraintName: "file_comparison_uploads_claim_check",
  },
] as const satisfies readonly OnlineConstraintValidation[];

export const FILE_LIFECYCLE_CONSTRAINT_VALIDATIONS =
  FILE_LIFECYCLE_CONSTRAINTS.map(
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
