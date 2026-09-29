import type { StreamChunk, StreamDurability } from "@tanstack/ai";
import { TaggedError } from "better-result";
import { and, asc, eq, gt, isNotNull, lt, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";

import { Temporal } from "@stll/time";

import type { Transaction, rootDb } from "@/api/db/root";
import { chatRunLogEntries, chatRunLogs, chatTurns } from "@/api/db/schema";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import type { SafeId } from "@/api/lib/branded-types";

const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_RUN_BYTES = 32 * MAX_CHUNK_BYTES;
const READ_PAGE_SIZE = 256;
const TAIL_POLL_MS = 250;
const FIRST_ENTRY_WAIT_MS = 30_000;
const CLOSED_LOG_RETENTION_MS = 15 * 60 * 1000;
const RETENTION_BATCH_SIZE = 128;

type RunLogDb = Pick<typeof rootDb, "transaction">;

export class ChatRunLogError extends TaggedError("ChatRunLogError")<{
  message: string;
}> {}

type ChatRunLogOptions = {
  db: RunLogDb;
  execution: ChatTurnExecution;
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
    await db.transaction(async (tx) => {
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
      const deadline =
        Temporal.Now.instant().epochMilliseconds + FIRST_ENTRY_WAIT_MS;
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        if (after === null) {
          const { log } = await loadPage(0n);
          after = log === undefined ? 0n : BigInt(log.nextSeq) - 1n;
        }
        const { entries, log } = await loadPage(after);
        for (const entry of entries) {
          after = BigInt(entry.seq);
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
        if (entries.length === READ_PAGE_SIZE) {
          continue;
        }
        await Bun.sleep(TAIL_POLL_MS);
      }
    },
    snapshot: async () =>
      await db.transaction(
        async (tx) => {
          const result: { offset: string; chunk: StreamChunk }[] = [];
          let after = 0n;
          for (;;) {
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
                ),
              )
              .orderBy(asc(chatRunLogEntries.seq))
              .limit(READ_PAGE_SIZE);
            for (const entry of entries) {
              after = BigInt(entry.seq);
              result.push({ offset: after.toString(), chunk: entry.chunk });
            }
            if (entries.length < READ_PAGE_SIZE) {
              return result;
            }
          }
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
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
  let pendingBatch: { id: string; chunks: StreamChunk[] } | null = null;
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
      if (
        pendingBatch !== null &&
        JSON.stringify(pendingBatch.chunks) !== JSON.stringify(chunks)
      ) {
        throw new ChatRunLogError({
          message: "A chat run log append is awaiting retry",
        });
      }
      pendingBatch ??= { id: Bun.randomUUIDv7(), chunks };
      const batch = pendingBatch;
      const bytes = chunks.map(chunkBytes);
      if (bytes.some((size) => size > MAX_CHUNK_BYTES)) {
        throw new ChatRunLogError({
          message: "Chat run log chunk exceeds its size limit",
        });
      }
      const offsets = await db.transaction(async (tx) => {
        await assertOwner(tx);
        // audit: skip — transient stream delivery, while turn settlement is audited
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
          if (
            alreadyStored.length !== chunks.length ||
            alreadyStored.some(
              (row, index) => !isDeepStrictEqual(row.chunk, chunks[index]),
            )
          ) {
            throw new ChatRunLogError({
              message: "Chat run log retry differs from stored batch",
            });
          }
          return alreadyStored.map((row) => BigInt(row.seq).toString());
        }
        const nextBytes =
          BigInt(log.bytesUsed) +
          BigInt(bytes.reduce((sum, size) => sum + size, 0));
        if (nextBytes > BigInt(MAX_RUN_BYTES)) {
          throw new ChatRunLogError({
            message: "Chat run log exceeds its size limit",
          });
        }
        const first = BigInt(log.nextSeq);
        // audit: skip — transient stream delivery, while turn settlement is audited
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
        // audit: skip — transient stream delivery sequence bookkeeping
        await tx
          .update(chatRunLogs)
          .set({ nextSeq: first + BigInt(chunks.length), bytesUsed: nextBytes })
          .where(logKey(organizationId, runId));
        return chunks.map((_, index) => (first + BigInt(index)).toString());
      });
      pendingBatch = null;
      return offsets;
    },
    // Settlement/recovery must close while holding the execution fence; the
    // SDK's later close call may only acknowledge an already-closed log.
    close: async () => {
      await db.transaction(async (tx) => {
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
          // audit: skip — transient stream delivery close marker
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
          // audit: skip — transient stream delivery close marker
          await tx
            .update(chatRunLogs)
            .set({ closedAt: sql`now()` })
            .where(logKey(organizationId, runId));
        }
      });
    },
  };
};

/** A bounded, repeatable sweep. Cascading turn deletion handles account and org erasure. */
export const sweepClosedChatRunLogs = async (db: RunLogDb): Promise<number> =>
  await db.transaction(async (tx) => {
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
            // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff is computed by PostgreSQL at its timestamp precision
            sql`now() - ${CLOSED_LOG_RETENTION_MS} * interval '1 millisecond'`,
          ),
        ),
      )
      .orderBy(
        asc(chatRunLogs.closedAt),
        asc(chatRunLogs.organizationId),
        asc(chatRunLogs.runId),
      )
      .limit(RETENTION_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (expired.length > 0) {
      // audit: skip — expired transient delivery rows are removed by retention
      await tx
        .delete(chatRunLogs)
        .where(
          or(...expired.map((row) => logKey(row.organizationId, row.runId))),
        );
    }
    return expired.length;
  });
