import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The delivery checks migration
 * 20261115120000_corpus_projection_offline_delivery adds NOT VALID: the table
 * grows with the corpus, and a validating scan does not fit the migration's
 * statement budget. Every existing row carries the column default, which both
 * checks admit, so there is no data work, only the validation. The status
 * checks the same migration replaces are validated again by the repair that
 * already owns them (`CORPUS_PROJECTION_CLEANUP_STALL_REPAIR`).
 */
export const CORPUS_PROJECTION_OFFLINE_DELIVERY_CONSTRAINTS = [
  {
    tableName: "corpus_index_projection_intents",
    constraintName: "corpus_index_projection_intents_append_delivery_values",
    introducedBy: "20261115120000_corpus_projection_offline_delivery",
  },
  {
    tableName: "corpus_index_projection_intents",
    constraintName: "corpus_index_projection_intents_append_delivery_shape",
    introducedBy: "20261115120000_corpus_projection_offline_delivery",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const CORPUS_PROJECTION_OFFLINE_DELIVERY_CONSTRAINT_VALIDATIONS =
  CORPUS_PROJECTION_OFFLINE_DELIVERY_CONSTRAINTS.map(
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
