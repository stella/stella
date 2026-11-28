import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The request cap check that migration
 * 20261127120000_corpus_projection_append_request_cap adds NOT VALID: the
 * table grows with the corpus, and a validating scan does not fit the
 * migration's statement budget. The column arrives with a constant default
 * the check admits, so every row satisfies it already and there is no data
 * work, only the validation.
 */
export const CORPUS_PROJECTION_APPEND_REQUEST_CAP_CONSTRAINTS = [
  {
    tableName: "corpus_index_projection_states",
    constraintName: "corpus_index_projection_states_append_request_cap_values",
    introducedBy: "20261127120000_corpus_projection_append_request_cap",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const CORPUS_PROJECTION_APPEND_REQUEST_CAP_CONSTRAINT_VALIDATIONS =
  CORPUS_PROJECTION_APPEND_REQUEST_CAP_CONSTRAINTS.map(
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
