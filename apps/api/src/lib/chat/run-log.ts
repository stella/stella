import { EventType, uiMessagesToWire } from "@tanstack/ai";
import type { StreamChunk, StreamDurability } from "@tanstack/ai";
import { panic, TaggedError } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { chatRunLogEntries, chatRunLogs, chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { emitChatRunLogMetric } from "@/api/lib/observability/request-metrics";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_RUN_BYTES = 32 * MAX_CHUNK_BYTES;
const READ_PAGE_SIZE = 256;
const TAIL_POLL_MS = 250;
const FIRST_ENTRY_WAIT_MS = 30_000;
const CLOSED_LOG_RETENTION = "15 minutes";
const RETENTION_HEADER_BATCH_SIZE = 32;
export const RETENTION_ENTRY_BATCH_SIZE = 64;

type SchedulerRunLogDb = Pick<SchedulerDb, "transaction">;

/** The fence a producer holds: its turn and the execution that claimed it. */
type ChatRunLogExecution = {
  executionId: string;
  id: SafeId<"chatTurn">;
};

class ChatRunLogError extends TaggedError("ChatRunLogError")<{
  message: string;
}> {}

type ChatRunLogOptions = {
  db: ScopedDb;
  execution: ChatRunLogExecution;
  organizationId: SafeId<"organization">;
  resumeOffset?: string | null;
  runId: string;
};

const offsetSequence = (offset: string): bigint => {
  if (!/^[1-9]\d*$/u.test(offset)) {
    throw new ChatRunLogError({ message: "Invalid chat run log offset" });
  }
  return BigInt(offset);
};

const chunkBytes = (chunk: StreamChunk): number =>
  new TextEncoder().encode(JSON.stringify(chunk)).byteLength;

const canonicalChunk = (chunk: StreamChunk): string =>
  JSON.stringify(chunk, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).toSorted(([left], [right]) =>
        left < right ? -1 : Number(left > right),
      ),
    );
  });

const logKey = (organizationId: SafeId<"organization">, runId: string) =>
  and(
    eq(chatRunLogs.organizationId, organizationId),
    eq(chatRunLogs.runId, runId),
  );

const entryKey = (organizationId: SafeId<"organization">, runId: string) =>
  and(
    eq(chatRunLogEntries.organizationId, organizationId),
    eq(chatRunLogEntries.runId, runId),
  );

type RunLogReaderOptions = Pick<
  ChatRunLogOptions,
  "db" | "organizationId" | "runId"
>;

const createRunLogReader = ({
  db,
  organizationId,
  runId,
}: RunLogReaderOptions): Pick<StreamDurability, "read" | "snapshot"> => {
  const loadPage = async (after: bigint) =>
    await db(async (tx) => {
      const [log] = await tx
        .select({
          closedAt: chatRunLogs.closedAt,
          nextSeq: chatRunLogs.nextSeq,
        })
        .from(chatRunLogs)
        .where(logKey(organizationId, runId))
        .limit(1);
      const entries = await tx
        .select({ chunk: chatRunLogEntries.chunk, seq: chatRunLogEntries.seq })
        .from(chatRunLogEntries)
        .where(
          and(
            entryKey(organizationId, runId),
            gt(chatRunLogEntries.seq, after),
          ),
        )
        .orderBy(asc(chatRunLogEntries.seq))
        .limit(READ_PAGE_SIZE);
      return { entries, log };
    });

  return {
    async *read(offset, signal) {
      let after: bigint | null;
      if (offset === "-1") {
        after = 0n;
      } else if (offset === "now") {
        after = null;
      } else {
        after = offsetSequence(offset);
      }
      if (after === null) {
        const { log } = await loadPage(0n);
        after = log === undefined ? 0n : log.nextSeq - 1n;
      }
      const deadline =
        Temporal.Now.instant().epochMilliseconds + FIRST_ENTRY_WAIT_MS;
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        // db-await-in-loop: tailing page walk; each read starts after the last yielded seq, a page holds at most READ_PAGE_SIZE rows, and the loop ends at the close marker, the not-found deadline, or the abort signal
        const { entries, log } = await loadPage(after);
        for (const entry of entries) {
          // Final append precedes the transaction that stores the transcript
          // and closes the log. Hold an open tail terminal until that commit;
          // intermediate finishes release once the next iteration appends.
          if (
            log !== undefined &&
            log.closedAt === null &&
            entry.seq === log.nextSeq - 1n &&
            (entry.chunk.type === EventType.RUN_FINISHED ||
              entry.chunk.type === EventType.RUN_ERROR)
          ) {
            break;
          }
          after = entry.seq;
          yield { offset: after.toString(), chunk: entry.chunk };
        }
        if (
          log !== undefined &&
          log.closedAt !== null &&
          entries.length < READ_PAGE_SIZE
        ) {
          return;
        }
        if (
          log === undefined &&
          Temporal.Now.instant().epochMilliseconds >= deadline
        ) {
          throw new ChatRunLogError({ message: "Chat run log was not found" });
        }
        if (
          entries.length === READ_PAGE_SIZE &&
          after === entries.at(-1)?.seq
        ) {
          continue;
        }
        await Bun.sleep(TAIL_POLL_MS);
      }
    },
    snapshot: async () =>
      await db(async (tx) => {
        const [log] = await tx
          .select({ nextSeq: chatRunLogs.nextSeq })
          .from(chatRunLogs)
          .where(logKey(organizationId, runId))
          .limit(1);
        if (log === undefined) {
          return [];
        }
        const result: { offset: string; chunk: StreamChunk }[] = [];
        let after = 0n;
        for (;;) {
          // db-await-in-loop: snapshot page walk in one transaction; each page starts after the last seq read, holds at most READ_PAGE_SIZE rows, and stops below the header's next_seq
          const entries = await tx
            .select({
              chunk: chatRunLogEntries.chunk,
              seq: chatRunLogEntries.seq,
            })
            .from(chatRunLogEntries)
            .where(
              and(
                entryKey(organizationId, runId),
                gt(chatRunLogEntries.seq, after),
                lt(chatRunLogEntries.seq, log.nextSeq),
              ),
            )
            .orderBy(asc(chatRunLogEntries.seq))
            .limit(READ_PAGE_SIZE);
          for (const entry of entries) {
            after = entry.seq;
            result.push({ offset: after.toString(), chunk: entry.chunk });
          }
          if (entries.length < READ_PAGE_SIZE) {
            if (after !== log.nextSeq - 1n) {
              throw new ChatRunLogError({
                message: "Chat run log changed during snapshot",
              });
            }
            return result;
          }
        }
      }),
  };
};

// A reconnect replays at most 256 deltas or a 1 MiB suffix. Larger prefixes
// fold into one canonical SDK transcript snapshot, bounded by MAX_RUN_BYTES.
const MAX_CATCHUP_CHUNKS = 256n;
const MAX_CATCHUP_BYTES = 1024n * 1024n;

export const createChatRunLogReplay = async ({
  db,
  organizationId,
  runId,
  resumeOffset,
  waitForStart = false,
}: RunLogReaderOptions & {
  waitForStart?: boolean;
  resumeOffset: string;
}): Promise<StreamDurability | null> => {
  const header = await db(async (tx) =>
    (
      await tx
        .select({
          closedAt: chatRunLogs.closedAt,
          nextSeq: chatRunLogs.nextSeq,
          bytesUsed: chatRunLogs.bytesUsed,
        })
        .from(chatRunLogs)
        .where(logKey(organizationId, runId))
        .limit(1)
    ).at(0),
  );
  const reader = createRunLogReader({ db, organizationId, runId });
  if (header === undefined) {
    return waitForStart
      ? {
          ...reader,
          resumeFrom: () => resumeOffset,
          append: async () => panic("A rejoined chat run cannot produce"),
          close: async () => {
            // A viewer closes delivery without closing the producer log.
          },
        }
      : null;
  }
  if (header.closedAt !== null) {
    return null;
  }
  const after = (() => {
    if (resumeOffset === "-1") {
      return 0n;
    }
    if (resumeOffset === "now") {
      return header.nextSeq - 1n;
    }
    return offsetSequence(resumeOffset);
  })();
  if (after >= header.nextSeq) {
    throw new ChatRunLogError({
      message: "Chat run log offset is beyond the stored tail",
    });
  }
  // Headers let small runs skip the range aggregate; large runs measure only
  // the requested indexed suffix, so a recent reader does not compact again.
  const gapBytes =
    header.bytesUsed <= MAX_CATCHUP_BYTES
      ? header.bytesUsed
      : await db(async (tx) => {
          const [range] = await tx
            .select({
              bytes: sql<string>`coalesce(sum(octet_length(${chatRunLogEntries.chunk}::text)), 0)::text`,
            })
            .from(chatRunLogEntries)
            .where(
              and(
                entryKey(organizationId, runId),
                gt(chatRunLogEntries.seq, after),
              ),
            );
          return BigInt(
            range?.bytes ??
              panic("Chat catch-up byte aggregate returned no row"),
          );
        });
  const compact =
    header.nextSeq - 1n - after > MAX_CATCHUP_CHUNKS ||
    gapBytes > MAX_CATCHUP_BYTES;
  return {
    ...reader,
    resumeFrom: () => resumeOffset,
    append: async () => panic("A rejoined chat run cannot produce"),
    close: async () => {
      // A viewer closes delivery without closing the producer log.
    },
    async *read(offset, signal) {
      if (!compact) {
        yield* reader.read(offset, signal);
        return;
      }
      const prefix = await reader.snapshot();
      const final = prefix.at(-1);
      // A snapshot restores message state; the terminal still carries native
      // interrupt descriptors and must pass through the ordinary close fence.
      if (
        final?.chunk.type === EventType.RUN_FINISHED ||
        final?.chunk.type === EventType.RUN_ERROR
      ) {
        prefix.pop();
      }
      const last = prefix.at(-1);
      if (last === undefined) {
        yield* reader.read(offset, signal);
        return;
      }
      const { processor } = createStreamMessageCapture({
        initialMessages: [],
        capture: (message) => message,
      });
      for (const { chunk } of prefix) {
        processor.processChunk(chunk);
      }
      yield {
        offset: last.offset,
        chunk: {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: uiMessagesToWire(processor.getMessages(), {
            includeSnapshotStructuredOutput: true,
          }),
        },
      };
      yield* reader.read(last.offset, signal);
    },
  };
};

/** PostgreSQL owns the turn fence, event prefix, and close marker together. */
export const createChatRunLog = ({
  db,
  execution,
  organizationId,
  resumeOffset = null,
  runId,
}: ChatRunLogOptions): StreamDurability => {
  let pendingBatch: { id: string; fingerprint: string } | null = null;
  const reader = createRunLogReader({ db, organizationId, runId });

  const assertOwner = async (tx: Transaction) => {
    const rows = await tx
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.id, execution.id),
          eq(chatTurns.organizationId, organizationId),
          eq(chatTurns.runId, runId),
          eq(chatTurns.executionId, execution.executionId),
          eq(chatTurns.status, "running"),
        ),
      )
      .for("update")
      .limit(1);
    if (rows.length !== 1) {
      throw new ChatRunLogError({
        message: "Chat run log execution fence lost",
      });
    }
  };

  return {
    ...reader,
    resumeFrom: () => resumeOffset,
    append: async (chunks) => {
      if (chunks.length === 0) {
        return [];
      }
      const fingerprint = JSON.stringify(chunks.map(canonicalChunk));
      if (pendingBatch !== null && pendingBatch.fingerprint !== fingerprint) {
        throw new ChatRunLogError({
          message: "A chat run log append is awaiting retry",
        });
      }
      pendingBatch ??= { id: Bun.randomUUIDv7(), fingerprint };
      const batch = pendingBatch;
      const bytes = chunks.map(chunkBytes);
      if (bytes.some((size) => size > MAX_CHUNK_BYTES)) {
        throw new ChatRunLogError({
          message: "Chat run log chunk exceeds its size limit",
        });
      }
      const startedAt = performance.now();
      const offsets = await db(async (tx) => {
        await assertOwner(tx);
        await tx
          .insert(chatRunLogs)
          .values({ organizationId, runId, turnId: execution.id })
          .onConflictDoNothing();
        const [log] = await tx
          .select({
            bytesUsed: chatRunLogs.bytesUsed,
            closedAt: chatRunLogs.closedAt,
            nextSeq: chatRunLogs.nextSeq,
            turnId: chatRunLogs.turnId,
          })
          .from(chatRunLogs)
          .where(logKey(organizationId, runId))
          .for("update")
          .limit(1);
        if (
          log === undefined ||
          log.turnId !== execution.id ||
          log.closedAt !== null
        ) {
          throw new ChatRunLogError({
            message: "Chat run log is closed or bound to another turn",
          });
        }
        const alreadyStored = await tx
          .select({
            chunk: chatRunLogEntries.chunk,
            seq: chatRunLogEntries.seq,
          })
          .from(chatRunLogEntries)
          .where(
            and(
              entryKey(organizationId, runId),
              eq(chatRunLogEntries.batchId, batch.id),
            ),
          )
          .orderBy(asc(chatRunLogEntries.batchIndex))
          .limit(chunks.length + 1);
        if (alreadyStored.length > 0) {
          // The batch id is minted per fingerprint above, so its stored rows
          // can only be this exact batch.
          if (
            alreadyStored.length !== chunks.length ||
            alreadyStored.some((row, index) => {
              const chunk = chunks.at(index);
              return (
                chunk === undefined ||
                canonicalChunk(row.chunk) !== canonicalChunk(chunk)
              );
            })
          ) {
            panic("Chat run log retry differs from stored batch");
          }
          return alreadyStored.map((row) => row.seq.toString());
        }
        const nextBytes =
          log.bytesUsed + BigInt(bytes.reduce((sum, size) => sum + size, 0));
        if (nextBytes > BigInt(MAX_RUN_BYTES)) {
          throw new ChatRunLogError({
            message: "Chat run log exceeds its size limit",
          });
        }
        const first = log.nextSeq;
        await tx.insert(chatRunLogEntries).values(
          chunks.map((chunk, index) => ({
            organizationId,
            runId,
            seq: first + BigInt(index),
            batchId: batch.id,
            batchIndex: index,
            chunk,
          })),
        );
        await tx
          .update(chatRunLogs)
          .set({ nextSeq: first + BigInt(chunks.length), bytesUsed: nextBytes })
          .where(logKey(organizationId, runId));
        return chunks.map((_, index) => (first + BigInt(index)).toString());
      });
      pendingBatch = null;
      emitChatRunLogMetric({
        type: "append",
        durationMs: performance.now() - startedAt,
      });
      return offsets;
    },
    // Settlement/recovery must close while holding the execution fence; the
    // SDK's later close call may only acknowledge an already-closed log.
    close: async () => {
      await db(async (tx) => {
        const [closed] = await tx
          .select({
            turnId: chatRunLogs.turnId,
            closedAt: chatRunLogs.closedAt,
          })
          .from(chatRunLogs)
          .where(logKey(organizationId, runId))
          .limit(1);
        if (closed !== undefined && closed.turnId !== execution.id) {
          throw new ChatRunLogError({
            message: "Chat run log belongs to another turn",
          });
        }
        if (closed !== undefined && closed.closedAt !== null) {
          return;
        }
        await assertOwner(tx);
        const [log] = await tx
          .select({
            turnId: chatRunLogs.turnId,
            closedAt: chatRunLogs.closedAt,
          })
          .from(chatRunLogs)
          .where(logKey(organizationId, runId))
          .for("update")
          .limit(1);
        if (log === undefined) {
          await tx.insert(chatRunLogs).values({
            organizationId,
            runId,
            turnId: execution.id,
            closedAt: sql`now()`,
          });
        } else if (log.turnId !== execution.id) {
          throw new ChatRunLogError({
            message: "Chat run log belongs to another turn",
          });
        } else if (log.closedAt === null) {
          await tx
            .update(chatRunLogs)
            .set({ closedAt: sql`now()` })
            .where(logKey(organizationId, runId));
        }
      });
    },
  };
};

/** Close the log in the transaction that removes its turn's execution fence. */
export const closeChatRunLogOnTx = async ({
  organizationId,
  runId,
  turnId,
  tx,
}: {
  organizationId: SafeId<"organization">;
  runId: string | null;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
}): Promise<void> => {
  if (runId === null) {
    return;
  }
  await tx
    .update(chatRunLogs)
    .set({ closedAt: sql`now()` })
    .where(
      and(
        logKey(organizationId, runId),
        eq(chatRunLogs.turnId, turnId),
        isNull(chatRunLogs.closedAt),
      ),
    );
};

/** One bounded retention batch; only the scheduler receives the owner connection. */
export const sweepClosedChatRunLogs = async (db: SchedulerRunLogDb) =>
  await db.transaction(async (tx) => {
    const abandoned = await tx
      .select({
        organizationId: chatRunLogs.organizationId,
        runId: chatRunLogs.runId,
      })
      .from(chatRunLogs)
      .innerJoin(
        chatTurns,
        and(
          eq(chatTurns.id, chatRunLogs.turnId),
          eq(chatTurns.organizationId, chatRunLogs.organizationId),
        ),
      )
      .where(and(isNull(chatRunLogs.closedAt), ne(chatTurns.status, "running")))
      .orderBy(
        asc(chatRunLogs.createdAt),
        asc(chatRunLogs.organizationId),
        asc(chatRunLogs.runId),
      )
      .limit(RETENTION_HEADER_BATCH_SIZE)
      .for("update", { of: chatRunLogs, skipLocked: true });
    if (abandoned.length > 0) {
      await tx
        .update(chatRunLogs)
        .set({ closedAt: sql`now()` })
        .where(
          or(...abandoned.map((row) => logKey(row.organizationId, row.runId))),
        );
    }
    const expired = await tx
      .select({
        organizationId: chatRunLogs.organizationId,
        runId: chatRunLogs.runId,
      })
      .from(chatRunLogs)
      .where(
        and(
          isNotNull(chatRunLogs.closedAt),
          lt(
            chatRunLogs.closedAt,
            sql`now() - ${CLOSED_LOG_RETENTION}::interval`,
          ),
        ),
      )
      .orderBy(
        asc(chatRunLogs.closedAt),
        asc(chatRunLogs.organizationId),
        asc(chatRunLogs.runId),
      )
      .limit(RETENTION_HEADER_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (expired.length === 0) {
      return {
        entriesDeleted: 0,
        logsClosed: abandoned.length,
        logsDeleted: 0,
      };
    }
    const keys = or(
      ...expired.map((row) => entryKey(row.organizationId, row.runId)),
    );
    const entries = await tx
      .select({
        organizationId: chatRunLogEntries.organizationId,
        runId: chatRunLogEntries.runId,
        seq: chatRunLogEntries.seq,
      })
      .from(chatRunLogEntries)
      .where(keys)
      .orderBy(
        asc(chatRunLogEntries.organizationId),
        asc(chatRunLogEntries.runId),
        asc(chatRunLogEntries.seq),
      )
      .limit(RETENTION_ENTRY_BATCH_SIZE);
    if (entries.length > 0) {
      await tx
        .delete(chatRunLogEntries)
        .where(
          or(
            ...entries.map((entry) =>
              and(
                entryKey(entry.organizationId, entry.runId),
                eq(chatRunLogEntries.seq, entry.seq),
              ),
            ),
          ),
        );
    }
    const deleted = await tx
      .delete(chatRunLogs)
      .where(
        and(
          or(...expired.map((row) => logKey(row.organizationId, row.runId))),
          sql`NOT EXISTS (SELECT 1 FROM ${chatRunLogEntries} WHERE ${chatRunLogEntries.organizationId} = ${chatRunLogs.organizationId} AND ${chatRunLogEntries.runId} = ${chatRunLogs.runId})`,
        ),
      )
      .returning({ runId: chatRunLogs.runId });
    return {
      entriesDeleted: entries.length,
      logsClosed: abandoned.length,
      logsDeleted: deleted.length,
    };
  });
