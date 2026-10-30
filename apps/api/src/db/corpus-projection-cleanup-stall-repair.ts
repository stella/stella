/**
 * Online repair behind migration
 * 20261003123500_corpus_projection_cleanup_reissue.
 *
 * The migration replaces the intent status checks with supersets that admit
 * `cleanup_stalled` and adds the re-issue counter's check, all NOT VALID: the
 * table grows with the corpus, and a validating scan does not fit the
 * migration's statement budget. Every existing row satisfied the checks they
 * replace, so there is no data work, only the validation. VALIDATE takes
 * SHARE UPDATE EXCLUSIVE, so writers keep going while it scans.
 */

import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { MigrationOwnedOnlineRepair } from "./online-migration-connection";

const REPAIR_NAME = "corpus-projection-cleanup-stall";
const TABLE_NAME = "corpus_index_projection_intents";
const CONSTRAINT_NAMES = [
  "corpus_index_projection_intents_status_values",
  "corpus_index_projection_intents_status_shape",
  "corpus_index_projection_intents_delete_reissues_nonnegative",
] as const;

export const CORPUS_PROJECTION_CLEANUP_STALL_CONSTRAINTS = CONSTRAINT_NAMES.map(
  (constraintName) => ({ tableName: TABLE_NAME, constraintName }),
) satisfies readonly OnlineConstraintValidation[];

export const CORPUS_PROJECTION_CLEANUP_STALL_REPAIR: MigrationOwnedOnlineRepair =
  {
    introducedBy: "20261003123500_corpus_projection_cleanup_reissue",
    name: REPAIR_NAME,
    readCompletion: async (connection) => {
      for (const constraintName of CONSTRAINT_NAMES) {
        const completion = await readConstraintCompletion({
          connection,
          constraintName,
          repairName: REPAIR_NAME,
          tableName: TABLE_NAME,
        });
        if (completion.type !== "complete") {
          return completion;
        }
      }
      return { type: "complete" };
    },
    // VALIDATE queues behind an autovacuum of the table until that vacuum
    // notices the waiter and yields; the gate watches that wait and defers.
    repair: async (connection, tables) =>
      await validateOnlineConstraints({
        connection,
        tables,
        constraints: CORPUS_PROJECTION_CLEANUP_STALL_CONSTRAINTS,
      }),
  };
