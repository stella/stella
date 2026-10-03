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
import type { OnlineRepair } from "./online-migration-connection";

const REPAIR_NAME = "corpus-projection-cleanup-stall";
const TABLE_NAME = "corpus_index_projection_intents";
const CONSTRAINT_NAMES = [
  "corpus_index_projection_intents_status_values",
  "corpus_index_projection_intents_status_shape",
  "corpus_index_projection_intents_delete_reissues_nonnegative",
] as const;
/**
 * VALIDATE queues behind an autovacuum of the table until that vacuum notices
 * the waiter and yields. Longer than the online phase's default, which is
 * sized for index builds; the phase restores its own setting afterwards.
 */
const VALIDATE_LOCK_TIMEOUT = "1min";

export const CORPUS_PROJECTION_CLEANUP_STALL_REPAIR: OnlineRepair = {
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
  repair: async (connection) => {
    await connection.execute(`SET lock_timeout = '${VALIDATE_LOCK_TIMEOUT}'`);
    // A no-op on an already validated constraint, which is what makes the
    // repair a fixed point.
    for (const constraintName of CONSTRAINT_NAMES) {
      await connection.execute(
        `ALTER TABLE public."${TABLE_NAME}" VALIDATE CONSTRAINT "${constraintName}"`,
      );
    }
  },
};
