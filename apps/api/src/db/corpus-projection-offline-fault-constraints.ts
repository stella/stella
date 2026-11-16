import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The fault checks migration 20261115220000_corpus_projection_offline_fault
 * adds NOT VALID: the table grows with the corpus, and a validating scan does
 * not fit the migration's statement budget. No offline revision was committed
 * before the column existed, so every row satisfies both already and there is
 * no data work, only the validation.
 */
export const CORPUS_PROJECTION_OFFLINE_FAULT_CONSTRAINTS = [
  {
    tableName: "corpus_index_projection_intents",
    constraintName: "corpus_index_projection_intents_append_fault_values",
    introducedBy: "20261115220000_corpus_projection_offline_fault",
  },
  {
    tableName: "corpus_index_projection_intents",
    constraintName: "corpus_index_projection_intents_append_fault_shape",
    introducedBy: "20261115220000_corpus_projection_offline_fault",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const CORPUS_PROJECTION_OFFLINE_FAULT_CONSTRAINT_VALIDATIONS =
  CORPUS_PROJECTION_OFFLINE_FAULT_CONSTRAINTS.map(
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
