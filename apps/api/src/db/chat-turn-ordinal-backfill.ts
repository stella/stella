/**
 * Turns stored before turns carried a position get one: 1, 2, 3 in each
 * thread, in the order the turns were read in until now, `(created_at, id)`.
 *
 * Only a turn without a position is read and only its `ordinal` is written,
 * guarded by `ordinal IS NULL`: a committed batch is never selected again, a
 * re-run changes nothing, and no other column of a turn is touched. The
 * unnumbered turns are the checkpoint, so an interrupted pass resumes where
 * it stopped.
 *
 * A batch takes the lock of each thread it numbers, the one a send holds
 * while it stores a turn, and reads the thread's turns in a later statement,
 * so it numbers what the send before it committed. A turn inserted since the
 * column exists has its position from the insert trigger, which starts a
 * thread above the turns it already holds (`assign_chat_turn_ordinal`): the
 * positions written here are at most that many, so they stay below it and no
 * numbered turn changes its number. The thread's counter is set to the
 * largest position it holds when it has none yet, so a position a later edit
 * deletes is not given out again.
 *
 * Until a thread is numbered, `chat-turn-order.ts` reads its turns in the
 * same stored order, so nothing waits on this.
 */

import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import type { Verdict } from "@stll/db-load-gate/health";

import { lockChatThreadsForTurnNumbering } from "@/api/lib/db/aggregate-lock";
import { isRecord } from "@/api/lib/type-guards";

import { loadGateHealthConfig } from "../env-online-index";
import { createBackfillRuntime } from "./backfill-runtime";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const REPAIR_NAME = "chat-turn-ordinals";
/** Threads per batch; a thread's turns are numbered together. */
const BATCH = 200;
const UNNUMBERED = "ordinal IS NULL";

const decodeThreadId = (row: unknown): string =>
  isRecord(row) && typeof row["thread_id"] === "string"
    ? row["thread_id"]
    : panic("Invalid unnumbered chat thread row");

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> => {
  const pending = await connection.query(
    `SELECT 1 FROM public.chat_turns WHERE ${UNNUMBERED} LIMIT 1`,
  );
  if (pending.length === 0) {
    return { type: "complete" };
  }
  const reason = "chat turns stored before positions await their position";
  const checkpoint = await connection.query(
    "SELECT 1 FROM public.database_backfill_states WHERE name = $1",
    [REPAIR_NAME],
  );
  return checkpoint.length === 0
    ? { type: "incomplete", reason }
    : {
        type: "pending",
        reason,
        cursor: null,
        holdUntil: null,
        heldSince: null,
      };
};

type BackfillOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
  /** Threads per batch; the runtime may shrink it under load. */
  batchSize?: number;
};

export const createChatTurnOrdinalBackfill = ({
  readVerdict,
  sleep = Bun.sleep,
  clock,
  log,
  batchSize = BATCH,
}: BackfillOptions = {}) =>
  ({
    name: REPAIR_NAME,
    introducedBy: "20261114180000_chat_turn_ordinals",
    readCompletion,
    repair: async (connection) => {
      const runtime = createBackfillRuntime({
        name: REPAIR_NAME,
        tableName: "chat_turns",
        initialSize: batchSize,
        config: loadGateHealthConfig(),
        connection,
        readVerdict,
        clock,
        log,
      });
      try {
        const pass = await runBackfillPass({
          holdPolicy: "propagate",
          sleep,
          step: async () =>
            await runtime.step(async ({ tx, size, cursor }) => {
              const after = cursor === null ? "" : "AND thread_id > $2::uuid";
              const threadIds = (
                await tx.query(
                  `SELECT DISTINCT thread_id::text AS thread_id
                     FROM public.chat_turns
                    WHERE ${UNNUMBERED} ${after}
                    ORDER BY thread_id
                    LIMIT $1`,
                  cursor === null
                    ? [Math.min(size, batchSize)]
                    : [Math.min(size, batchSize), cursor],
                )
              ).map(decodeThreadId);
              const last = threadIds.at(-1);
              if (last === undefined) {
                return { cursor: null, done: true, value: 0 };
              }
              // One joined parameter: the migrate connection binds no arrays.
              const batch = [threadIds.join(",")];
              // The statements below read what the senders before this
              // lock committed.
              await lockChatThreadsForTurnNumbering(tx, threadIds.join(","));
              await tx.query(
                `UPDATE public.chat_turns AS turn
                    SET ordinal = numbered.ordinal
                   FROM (
                     SELECT id,
                            row_number() OVER (
                              PARTITION BY thread_id ORDER BY created_at, id
                            )::integer AS ordinal
                       FROM public.chat_turns
                      WHERE thread_id = ANY(string_to_array($1, ',')::uuid[])
                        AND ${UNNUMBERED}
                   ) AS numbered
                  WHERE turn.id = numbered.id
                    AND turn.${UNNUMBERED}`,
                batch,
              );
              await tx.query(
                `UPDATE public.chat_threads AS thread
                    SET last_turn_ordinal = held.largest
                   FROM (
                     SELECT thread_id, max(ordinal) AS largest
                       FROM public.chat_turns
                      WHERE thread_id = ANY(string_to_array($1, ',')::uuid[])
                      GROUP BY thread_id
                   ) AS held
                  WHERE thread.id = held.thread_id
                    AND thread.last_turn_ordinal IS NULL`,
                batch,
              );
              return { cursor: last, done: false, value: threadIds.length };
            }),
        });
        if (pass.isErr()) {
          throw pass.error;
        }
        return { type: "complete" };
      } finally {
        await runtime.close();
      }
    },
  }) satisfies OnlineRepair;

export const CHAT_TURN_ORDINAL_BACKFILL = createChatTurnOrdinalBackfill();
