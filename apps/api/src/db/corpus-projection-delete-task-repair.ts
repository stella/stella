/**
 * Online repair behind migration
 * 20261118100000_corpus_projection_delete_tasks.
 *
 * The migration's triggers queue a delete task in the transaction that stamps
 * its receipt on a revision, so every task recorded from then on has its row.
 * A task recorded earlier has revisions waiting in `cleanup_committed` and no
 * row, and the settlement claim cannot reach it until this walk adds one.
 *
 * The walk visits the committed backlog's distinct tasks in key order through
 * the settlement batch index: a bounded number of tasks per transaction, each
 * transaction reading only those tasks' revisions, and nothing else of the
 * revision table. It inserts and never updates, and it takes no projection
 * fence: a task row only says where the claim should look, and the claim and
 * settlement re-read the revisions under lock.
 *
 * - A task whose revisions settle while the walk passes may get a row with
 *   nothing left behind it; the claim drops such a row the first time it
 *   reaches it.
 * - A task the triggers queued first keeps its row (`ON CONFLICT DO
 *   NOTHING`), lease included.
 * - A receipt without its task instant is left out, as the claim always left
 *   it out: the receipt repair fills the instant in, and that write fires the
 *   trigger.
 *
 * The keyset cursor and adaptive holds commit with each batch, so an
 * interrupted walk resumes where it stopped, and one rerun from the start
 * adds nothing twice. A final cursor written after the last batch is the
 * proof the walk finished.
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

const REPAIR_NAME = "corpus-projection-delete-tasks";
const INTENTS_TABLE = "corpus_index_projection_intents";
const TASKS_TABLE = "corpus_index_projection_delete_tasks";
/** Delete tasks per batch; a task carries at most one delete's revisions. */
const BATCH_TASKS = 200;

/** The checkpoint cursor of a finished walk. No task key can equal it. */
const WALK_COMPLETE = "complete";

/** A task's key, in the order the settlement batch index sorts it. */
type DeleteTaskKey = readonly [
  family: string,
  generation: string,
  indexId: string,
  deleteOpstamp: string,
];

/** Sorts before every key: no family is empty and no opstamp is negative. */
const KEY_FLOOR: DeleteTaskKey = ["", "", "", "-1"];

/**
 * The status sits between the index id and the opstamp in the settlement
 * batch index; every row it holds is `cleanup_committed`, so naming the status
 * in the row comparison keeps it an index range.
 */
const keyAbove = (first: number) =>
  `(family, generation, index_id, status, delete_opstamp)
    > ($${first}, $${first + 1}, $${first + 2}, 'cleanup_committed', $${first + 3}::bigint)`;
const keyAtMost = (first: number) =>
  `(family, generation, index_id, status, delete_opstamp)
    <= ($${first}, $${first + 1}, $${first + 2}, 'cleanup_committed', $${first + 3}::bigint)`;

// The page is cut on the opstamp as a number; only its output is text, so a
// page ending at opstamp 2 never stops before 10 the way text order would.
const READ_TASK_KEYS_SQL = `
  SELECT family, generation, index_id, delete_opstamp::text AS delete_opstamp
  FROM (
    SELECT DISTINCT family, generation, index_id, delete_opstamp
    FROM public."${INTENTS_TABLE}"
    WHERE status = 'cleanup_committed'
      AND ${keyAbove(1)}
    ORDER BY family, generation, index_id, delete_opstamp
    LIMIT $5
  ) page
  ORDER BY page.family, page.generation, page.index_id, page.delete_opstamp
`;

const QUEUE_TASKS_SQL = `
  INSERT INTO public."${TASKS_TABLE}"
    (family, generation, index_id, delete_opstamp, task_created_at,
     cleanup_started_at)
  SELECT family, generation, index_id, delete_opstamp,
    min(delete_task_created_at), min(cleanup_started_at)
  FROM public."${INTENTS_TABLE}"
  WHERE status = 'cleanup_committed'
    AND delete_opstamp IS NOT NULL
    AND delete_task_created_at IS NOT NULL
    AND ${keyAbove(1)}
    AND ${keyAtMost(5)}
  GROUP BY family, generation, index_id, delete_opstamp
  ON CONFLICT ON CONSTRAINT corpus_index_projection_delete_tasks_pkey DO NOTHING
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

const READ_ANY_COMMITTED_SQL = `
  SELECT 1
  FROM public."${INTENTS_TABLE}"
  WHERE status = 'cleanup_committed'
  LIMIT 1
`;

const encodeKey = (key: DeleteTaskKey): string => JSON.stringify(key);

const decodeKey = (cursor: string | null): DeleteTaskKey => {
  if (cursor === null) {
    return KEY_FLOOR;
  }
  const parsed: unknown = JSON.parse(cursor);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    !parsed.every((part) => typeof part === "string")
  ) {
    return panic(`Online repair ${REPAIR_NAME}: invalid cursor`);
  }
  const [family, generation, indexId, deleteOpstamp] = parsed;
  if (
    family === undefined ||
    generation === undefined ||
    indexId === undefined ||
    deleteOpstamp === undefined
  ) {
    return panic(`Online repair ${REPAIR_NAME}: invalid cursor`);
  }
  return [family, generation, indexId, deleteOpstamp];
};

const requireKey = (row: unknown): DeleteTaskKey => {
  if (
    !isRecord(row) ||
    typeof row["family"] !== "string" ||
    typeof row["generation"] !== "string" ||
    typeof row["index_id"] !== "string" ||
    typeof row["delete_opstamp"] !== "string"
  ) {
    return panic(`Online repair ${REPAIR_NAME}: task key has an invalid shape`);
  }
  return [
    row["family"],
    row["generation"],
    row["index_id"],
    row["delete_opstamp"],
  ];
};

/**
 * One batch of the walk: queue the next `size` committed tasks after
 * `cursor`. Exported so a test can interleave single batches with live
 * settlement work.
 */
export const queueNextCorpusProjectionDeleteTasks = async (
  tx: Pick<OnlineMigrationConnection, "execute" | "query">,
  cursor: string | null,
  size: number,
): Promise<{ cursor: string; done: boolean }> => {
  const after = decodeKey(cursor);
  const keys = (await tx.query(READ_TASK_KEYS_SQL, [...after, size])).map(
    requireKey,
  );
  const last = keys.at(-1);
  if (last === undefined) {
    return { cursor: encodeKey(after), done: true };
  }
  await tx.execute(QUEUE_TASKS_SQL, [...after, ...last]);
  return { cursor: encodeKey(last), done: keys.length < size };
};

export type CorpusProjectionDeleteTaskRepairRuntime = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
  /** Tasks per batch; tests lower it to walk several batches. */
  batchTasks?: number;
};

const walkDeleteTasks = async (
  connection: OnlineMigrationConnection,
  {
    readVerdict,
    sleep = Bun.sleep,
    clock,
    log,
    batchTasks = BATCH_TASKS,
  }: CorpusProjectionDeleteTaskRepairRuntime,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: TASKS_TABLE,
    initialSize: batchTasks,
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
        await runtime.step(async ({ tx, cursor, size }) => ({
          ...(await queueNextCorpusProjectionDeleteTasks(tx, cursor, size)),
          value: null,
        })),
    });
  } finally {
    await runtime.close();
  }
};

export const createCorpusProjectionDeleteTaskRepair = (
  options: CorpusProjectionDeleteTaskRepairRuntime = {},
): MigrationOwnedOnlineRepair => ({
  introducedBy: "20261118100000_corpus_projection_delete_tasks",
  name: REPAIR_NAME,
  readCompletion: async (connection) => {
    const checkpoint = (
      await connection.query(READ_CHECKPOINT_SQL, [REPAIR_NAME])
    ).at(0);
    if (checkpoint === undefined) {
      // Never started. A database with no committed task owes nothing, which
      // is how a fresh one stays complete. One probe of the settlement index
      // decides it, however long the backlog: whether every committed task is
      // queued already is the walk's question, and it answers it in batches.
      const committed = await connection.query(READ_ANY_COMMITTED_SQL);
      return committed.length === 0
        ? { type: "complete" }
        : {
            type: "incomplete",
            reason: "Committed delete tasks are not queued for settlement yet",
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
      reason: "Committed delete tasks are still being queued for settlement",
      cursor: checkpoint["cursor"],
      holdUntil: batch["holdUntil"],
      heldSince: batch["heldSince"],
    };
  },
  repair: async (connection) => {
    const checkpoint = (
      await connection.query(READ_CHECKPOINT_SQL, [REPAIR_NAME])
    ).at(0);
    if (isRecord(checkpoint) && checkpoint["cursor"] === WALK_COMPLETE) {
      return { type: "complete" };
    }
    // Empty fresh databases have no heavy data work and no metric source yet.
    // A walk stopped after its last batch, whose tasks settlement has drained
    // since, ends here too: its checkpoint (a fresh database has none) is
    // marked complete like a finished walk's, or it would read pending.
    if ((await connection.query(READ_ANY_COMMITTED_SQL)).length === 0) {
      await connection.execute(RECORD_WALK_COMPLETE_SQL, [
        WALK_COMPLETE,
        REPAIR_NAME,
      ]);
      return { type: "complete" };
    }
    const pass = await walkDeleteTasks(connection, options);
    if (pass.isErr()) {
      throw pass.error;
    }
    // A run stopped before this line walks again from the start, which
    // queues nothing twice.
    await connection.execute(RECORD_WALK_COMPLETE_SQL, [
      WALK_COMPLETE,
      REPAIR_NAME,
    ]);
    return { type: "complete" };
  },
});

export const CORPUS_PROJECTION_DELETE_TASK_REPAIR =
  createCorpusProjectionDeleteTaskRepair();
