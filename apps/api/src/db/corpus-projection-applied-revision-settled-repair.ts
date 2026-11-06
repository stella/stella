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
 * The walk is bounded ranges of the revisions' primary key. A marked row leaves
 * the update's predicate, so an interrupted run resumes by running again, and
 * the cursor and adaptive holds commit with each batch. A final cursor written
 * after the last batch is the proof the walk finished.
 */

import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import type { Verdict } from "@stll/db-load-gate/health";

import { loadGateHealthConfig } from "../env-online-index";
import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
} from "./online-migration-connection";

const REPAIR_NAME = "corpus-projection-applied-revision-settled";
const STATES_TABLE = "corpus_index_projection_states";
const INTENTS_TABLE = "corpus_index_projection_intents";

const BATCH = 1000;
const BATCH_LOCK_TIMEOUT = "30s";
const BATCH_STATEMENT_TIMEOUT = "1min";

/** Primary-key floor: every UUID sorts after it, so the walk starts here. */
const ID_FLOOR = "00000000-0000-0000-0000-000000000000";
/** The checkpoint cursor of a finished walk. No UUID can equal it. */
const WALK_COMPLETE = "complete";

const READ_BATCH_BOUNDARY_SQL = `
  SELECT id
  FROM public."${INTENTS_TABLE}"
  WHERE id > $1
  ORDER BY id
  OFFSET $2
  LIMIT 1
`;

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

const readBatchBoundary = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  cursor: string,
  size: number,
): Promise<string | null> => {
  const row = (
    await connection.query(READ_BATCH_BOUNDARY_SQL, [cursor, size - 1])
  ).at(0);
  if (row === undefined) {
    return null;
  }
  if (!isRecord(row) || typeof row["id"] !== "string") {
    return panic(
      `Online repair ${REPAIR_NAME}: batch boundary has an invalid shape`,
    );
  }
  return row["id"];
};

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

const walkRevisions = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairRuntimeOptions,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: STATES_TABLE,
    initialSize: BATCH,
    config: {
      ...loadGateHealthConfig(),
      batchLockTimeoutMs: 30_000,
      batchStatementTimeoutMs: 60_000,
    },
    connection,
    readVerdict,
    clock,
    log,
  });
  try {
    return await runBackfillPass({
      holdPolicy: "propagate",
      sleep,
      step: async () =>
        await runtime.step(async ({ tx, cursor, size }) => {
          await tx.execute(`SET LOCAL lock_timeout = '${BATCH_LOCK_TIMEOUT}'`);
          await tx.execute(
            `SET LOCAL statement_timeout = '${BATCH_STATEMENT_TIMEOUT}'`,
          );
          const floor = cursor ?? ID_FLOOR;
          const boundary = await readBatchBoundary(tx, floor, size);
          if (boundary === null) {
            await tx.execute(REPAIR_TAIL_SQL, [floor]);
            return { cursor: floor, done: true, value: null };
          }
          await tx.execute(REPAIR_RANGE_SQL, [floor, boundary]);
          return { cursor: boundary, done: false, value: null };
        }),
    });
  } finally {
    await runtime.close();
  }
};

export const createCorpusProjectionAppliedRevisionSettledRepair = (
  options: RepairRuntimeOptions = {},
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
    const pass = await walkRevisions(connection, options);
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
