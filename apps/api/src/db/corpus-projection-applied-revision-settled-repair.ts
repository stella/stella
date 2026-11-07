/**
 * Online repair behind migration
 * 20261106140000_corpus_projection_revision_settled.
 *
 * The migration's triggers keep `applied_revision_settled` equal to the applied
 * revision's status from then on, but a revision that settled earlier still
 * reads false, and its replacement stays out of the append queue until this
 * walk marks it. Only that direction matters: a stale true would merely let the
 * queue's outstanding-intent probe refuse the row, as it always has.
 *
 * A marked row leaves the update's predicate, so an interrupted walk resumes by
 * running again. A final cursor written after the last batch is the proof the
 * walk finished.
 */

import { panic } from "better-result";

import { isRecord } from "../lib/type-guards";
import {
  type CorpusProjectionRevisionWalkRuntime,
  walkCorpusProjectionRevisions,
} from "./corpus-projection-revision-walk";
import type { MigrationOwnedOnlineRepair } from "./online-migration-connection";

const REPAIR_NAME = "corpus-projection-applied-revision-settled";
const STATES_TABLE = "corpus_index_projection_states";
const INTENTS_TABLE = "corpus_index_projection_intents";

/** The checkpoint cursor of a finished walk. No UUID can equal it. */
const WALK_COMPLETE = "complete";

const MARK_UNMARKED_SQL = `
  UPDATE public."${STATES_TABLE}" state
  SET "applied_revision_settled" = true
  FROM public."${INTENTS_TABLE}" revision
  WHERE state."applied_revision" = revision."id"
    AND revision."status" = 'settled'
    AND NOT state."applied_revision_settled"
`;

const REPAIR_RANGE_SQL = `${MARK_UNMARKED_SQL}
    AND revision."id" > $1
    AND revision."id" <= $2
`;

const REPAIR_TAIL_SQL = `${MARK_UNMARKED_SQL}
    AND revision."id" > $1
`;

const READ_CHECKPOINT_SQL = `
  SELECT cursor, batch
  FROM public.database_backfill_states
  WHERE name = $1
`;

const RECORD_WALK_COMPLETE_SQL = `
  UPDATE public.database_backfill_states
  SET cursor = $1
  WHERE name = $2
`;

const READ_ANY_UNMARKED_SQL = `
  SELECT 1
  FROM public."${STATES_TABLE}" state
  JOIN public."${INTENTS_TABLE}" revision ON revision."id" = state."applied_revision"
  WHERE revision."status" = 'settled'
    AND NOT state."applied_revision_settled"
  LIMIT 1
`;

export const createCorpusProjectionAppliedRevisionSettledRepair = (
  options: CorpusProjectionRevisionWalkRuntime = {},
): MigrationOwnedOnlineRepair => ({
  introducedBy: "20261106140000_corpus_projection_revision_settled",
  name: REPAIR_NAME,
  readCompletion: async (connection) => {
    const checkpoint = (
      await connection.query(READ_CHECKPOINT_SQL, [REPAIR_NAME])
    ).at(0);
    if (checkpoint === undefined) {
      // Never started. A database with nothing to mark owes nothing, which is
      // how a fresh one stays complete once the triggers carry every row.
      const unmarked = await connection.query(READ_ANY_UNMARKED_SQL);
      return unmarked.length === 0
        ? { type: "complete" }
        : {
            type: "incomplete",
            reason: "Settled applied revisions are not marked yet",
          };
    }
    if (
      !isRecord(checkpoint) ||
      !(
        checkpoint["cursor"] === null ||
        typeof checkpoint["cursor"] === "string"
      ) ||
      !isRecord(checkpoint["batch"])
    ) {
      return panic(`Online repair ${REPAIR_NAME}: invalid pending checkpoint`);
    }
    if (checkpoint["cursor"] === WALK_COMPLETE) {
      return { type: "complete" };
    }
    const { batch } = checkpoint;
    if (
      !(
        batch["holdUntil"] === null || typeof batch["holdUntil"] === "number"
      ) ||
      !(batch["heldSince"] === null || typeof batch["heldSince"] === "number")
    ) {
      return panic(`Online repair ${REPAIR_NAME}: invalid pending hold`);
    }
    return {
      type: "pending",
      reason: "Settled applied revisions are still being marked",
      cursor: checkpoint["cursor"],
      holdUntil: batch["holdUntil"],
      heldSince: batch["heldSince"],
    };
  },
  repair: async (connection) => {
    // Empty fresh databases have no heavy data work and no metric source yet.
    if (
      (
        await connection.query(
          `SELECT 1 FROM public."${INTENTS_TABLE}" LIMIT 1`,
        )
      ).length === 0
    ) {
      return { type: "complete" };
    }
    const pass = await walkCorpusProjectionRevisions(
      connection,
      {
        name: REPAIR_NAME,
        tableName: STATES_TABLE,
        repairRangeSql: REPAIR_RANGE_SQL,
        repairTailSql: REPAIR_TAIL_SQL,
      },
      options,
    );
    if (pass.isErr()) {
      throw pass.error;
    }
    // A run stopped before this line walks again from the start, which marks
    // nothing twice.
    await connection.execute(RECORD_WALK_COMPLETE_SQL, [
      WALK_COMPLETE,
      REPAIR_NAME,
    ]);
    return { type: "complete" };
  },
});

export const CORPUS_PROJECTION_APPLIED_REVISION_SETTLED_REPAIR =
  createCorpusProjectionAppliedRevisionSettledRepair();
