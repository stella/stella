import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The failure-kind check migration
 * 20261119180000_corpus_projection_document_language_failure replaces NOT
 * VALID: the table grows with the corpus, and a validating scan does not fit
 * the migration's statement budget. The replacement admits every kind the
 * check it replaces admitted, so every row satisfies it already and there is
 * no data work, only the validation.
 */
export const CORPUS_PROJECTION_DOCUMENT_LANGUAGE_CONSTRAINTS = [
  {
    tableName: "corpus_index_projection_states",
    constraintName: "corpus_index_projection_states_failure_kind_values",
    introducedBy: "20261119180000_corpus_projection_document_language_failure",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const CORPUS_PROJECTION_DOCUMENT_LANGUAGE_CONSTRAINT_VALIDATIONS =
  CORPUS_PROJECTION_DOCUMENT_LANGUAGE_CONSTRAINTS.map(
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
        // VALIDATE takes SHARE UPDATE EXCLUSIVE, so writers keep going while
        // it scans.
        repair: async (connection, tables) =>
          await validateOnlineConstraints({
            connection,
            tables,
            constraints: [constraint],
          }),
      }) satisfies OnlineRepair,
  );
