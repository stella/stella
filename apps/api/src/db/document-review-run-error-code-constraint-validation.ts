import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The run error code check migration
 * 20261107210000_document_review_run_withheld_sources widens to accept
 * `document_too_large`, re-added NOT VALID.
 */
export const DOCUMENT_REVIEW_RUN_ERROR_CODE_CONSTRAINTS = [
  {
    tableName: "document_review_runs",
    constraintName: "document_review_runs_error_code_values_check",
    introducedBy: "20261107210000_document_review_run_withheld_sources",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const DOCUMENT_REVIEW_RUN_ERROR_CODE_CONSTRAINT_VALIDATIONS =
  DOCUMENT_REVIEW_RUN_ERROR_CODE_CONSTRAINTS.map(
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
