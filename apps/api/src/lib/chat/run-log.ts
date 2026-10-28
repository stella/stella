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

import type { ChatTurnTiming } from "@stll/api-contract/chat";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatRunLogEntries,
  chatRunLogs,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionReferencesIn } from "@/api/lib/case-law/withdrawn-copy-projection";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { messageTurnTiming } from "@/api/lib/chat/turn-timing";
import { projectWithdrawnRunChunk } from "@/api/lib/chat/withdrawn-run-chunks";
import { emitChatRunLogMetric } from "@/api/lib/observability/request-metrics";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { isRecord } from "@/api/lib/type-guards";

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

/** A resume cursor this run's log never issued: the caller's input, not a defect. */
export class ChatRunLogOffsetBeyondTailError extends TaggedError(
  "ChatRunLogOffsetBeyondTailError",
)<{ message: string }> {}

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

const hasRunningTiming = (metadata: Record<string, unknown> | undefined) => {
  const timing = metadata?.["turnTiming"];
  return (
    typeof timing === "object" &&
    timing !== null &&
    "status" in timing &&
    timing.status === "running"
  );
};

const refreshRunningTiming = (
  chunk: StreamChunk,
  timing: ChatTurnTiming | null,
): StreamChunk => {
  if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
    return {
      ...chunk,
      messages: chunk.messages.map((message) =>
        hasRunningTiming(message.metadata)
          ? {
              ...message,
              metadata: { ...message.metadata, turnTiming: timing },
            }
          : message,
      ),
    };
  }
  if (
    (chunk.type === EventType.TEXT_MESSAGE_START ||
      chunk.type === EventType.TEXT_MESSAGE_END) &&
    hasRunningTiming(chunk.metadata)
  ) {
    return { ...chunk, metadata: { ...chunk.metadata, turnTiming: timing } };
  }
  return chunk;
};

const hasRunningChunkTiming = (chunk: StreamChunk) =>
  chunk.type === EventType.MESSAGES_SNAPSHOT
    ? chunk.messages.some((message) => hasRunningTiming(message.metadata))
    : (chunk.type === EventType.TEXT_MESSAGE_START ||
        chunk.type === EventType.TEXT_MESSAGE_END) &&
      hasRunningTiming(chunk.metadata);

const readCurrentRunTiming = async ({
  tx,
  organizationId,
  runId,
}: Pick<RunLogReaderOptions, "organizationId" | "runId"> & {
  tx: Transaction;
}) => {
  const [row] = await tx
    .select({
      timing: messageTurnTiming({
        messageId: chatTurns.timingMessageId,
        threadId: chatTurns.threadId,
        fallbackTurnId: chatTurns.id,
      }),
    })
    .from(chatRunLogs)
    .innerJoin(
      chatTurns,
      and(
        eq(chatTurns.id, chatRunLogs.turnId),
        eq(chatTurns.organizationId, chatRunLogs.organizationId),
      ),
    )
    .where(logKey(organizationId, runId))
    .limit(1);
  return row?.timing ?? null;
};

type RunLogHeaderOptions = Pick<
  RunLogReaderOptions,
  "organizationId" | "runId"
> & {
  tx: Transaction;
  includeReferences: boolean;
};
const readRunLogHeaderOnTx = async ({
  tx,
  organizationId,
  runId,
  includeReferences,
}: RunLogHeaderOptions) =>
  (
    await tx
      .select({
        closedAt: chatRunLogs.closedAt,
        nextSeq: chatRunLogs.nextSeq,
        subjectDecisionId: chatThreads.subjectDecisionId,
        sourceContent: chatMessages.content,
        decisionReferences: includeReferences
          ? sql`(select jsonb_agg(jsonb_build_object('seq', ref.seq::text, 'chunk', ref.chunk) order by ref.seq) from chat_run_log_entries ref where ref.organization_id = ${chatRunLogs.organizationId} and ref.run_id = ${chatRunLogs.runId})`
          : sql`null`,
        tailChunk: chatRunLogEntries.chunk,
        tailTimingSeq: sql<string | null>`(
            select pending.seq::text from chat_run_log_entries pending
            where pending.organization_id = ${chatRunLogs.organizationId}
              and pending.run_id = ${chatRunLogs.runId}
              and pending.seq = ${chatRunLogs.nextSeq} - 2
              and pending.chunk->>'type' = ${EventType.TEXT_MESSAGE_END}
              and pending.chunk->'metadata' ? 'turnTiming'
          )`,
      })
      .from(chatRunLogs)
      .innerJoin(
        chatTurns,
        and(
          eq(chatTurns.id, chatRunLogs.turnId),
          eq(chatTurns.organizationId, chatRunLogs.organizationId),
        ),
      )
      .innerJoin(chatThreads, eq(chatThreads.id, chatTurns.threadId))
      .leftJoin(
        chatMessages,
        and(
          eq(chatMessages.id, chatTurns.timingMessageId),
          eq(chatMessages.threadId, chatTurns.threadId),
        ),
      )
      .leftJoin(
        chatRunLogEntries,
        and(
          eq(chatRunLogEntries.organizationId, chatRunLogs.organizationId),
          eq(chatRunLogEntries.runId, chatRunLogs.runId),
          eq(chatRunLogEntries.seq, sql`${chatRunLogs.nextSeq} - 1`),
        ),
      )
      .where(logKey(organizationId, runId))
      .limit(1)
  ).at(0);
type RunLogHeader = Awaited<ReturnType<typeof readRunLogHeaderOnTx>>;

const createRunLogCopyProjection = () => {
  let projection:
    Awaited<ReturnType<typeof readWithdrawnCopyProjection>> | undefined;
  let runMarker: string | null | undefined;
  const checkedReferences = new Set<string>();
  const userMessageIds = new Set<string>();
  const userSequences = new Set<string>();
  const knownSequences = new Set<string>();
  let currentRole: string | undefined;
  const shownMarkers = new Set<string>();
  const isAuthoredEntry = ({
    chunk,
    seq,
    offset,
  }: {
    chunk: StreamChunk;
    seq?: bigint;
    offset?: string;
  }) => {
    const sequence = seq?.toString() ?? offset;
    if (sequence !== undefined && userSequences.has(sequence)) {
      return true;
    }
    if (sequence === undefined || !knownSequences.has(sequence)) {
      if (chunk.type === EventType.TEXT_MESSAGE_START) {
        currentRole = chunk.role ?? "assistant";
      } else if (
        chunk.type === EventType.TEXT_MESSAGE_CHUNK &&
        chunk.role !== undefined
      ) {
        currentRole = chunk.role;
      }
      const authored = currentRole === "user";
      if (chunk.type === EventType.TEXT_MESSAGE_END) {
        currentRole = undefined;
      }
      if (sequence !== undefined) {
        knownSequences.add(sequence);
        if (authored) {
          userSequences.add(sequence);
        }
      }
      if (authored) {
        return true;
      }
    }
    if (chunk.type === EventType.TEXT_MESSAGE_CHUNK && chunk.role === "user") {
      return true;
    }
    if (chunk.type === EventType.TEXT_MESSAGE_START && chunk.role === "user") {
      userMessageIds.add(chunk.messageId);
    }
    if (
      (chunk.type === EventType.TEXT_MESSAGE_START ||
        chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
        chunk.type === EventType.TEXT_MESSAGE_END) &&
      userMessageIds.has(chunk.messageId)
    ) {
      return true;
    }
    return false;
  };
  const projectEntries = async <
    T extends { chunk: StreamChunk; seq?: bigint; offset?: string },
  >({
    entries,
    log,
  }: {
    entries: T[];
    log: RunLogHeader;
  }) => {
    if (Array.isArray(log?.decisionReferences)) {
      for (const record of log.decisionReferences) {
        if (
          !isRecord(record) ||
          typeof record["seq"] !== "string" ||
          !isRecord(record["chunk"])
        ) {
          continue;
        }
        knownSequences.add(record["seq"]);
        const chunk = record["chunk"];
        if (
          chunk["type"] === EventType.TEXT_MESSAGE_START ||
          chunk["type"] === EventType.TEXT_MESSAGE_CHUNK
        ) {
          if (chunk["type"] === EventType.TEXT_MESSAGE_START) {
            currentRole =
              typeof chunk["role"] === "string" ? chunk["role"] : "assistant";
          } else if (typeof chunk["role"] === "string") {
            currentRole = chunk["role"];
          }
          if (
            chunk["role"] === "user" &&
            typeof chunk["messageId"] === "string"
          ) {
            userMessageIds.add(chunk["messageId"]);
          }
        }
        if (currentRole === "user") {
          userSequences.add(record["seq"]);
        }
        if (chunk["type"] === EventType.TEXT_MESSAGE_END) {
          currentRole = undefined;
        }
      }
    }
    const references = decisionReferencesIn([log, entries]);
    if (
      projection === undefined ||
      [...references].some((id) => !checkedReferences.has(id))
    ) {
      projection = await readWithdrawnCopyProjection({
        values: [log, entries],
        decisionIds: [...checkedReferences],
      });
      for (const id of references) {
        checkedReferences.add(id);
      }
    }
    runMarker ??= projection.marker([log, entries], log?.subjectDecisionId);
    const marker = runMarker;
    return entries.map((entry) => {
      const chunk = entry.chunk;
      if (isAuthoredEntry(entry)) {
        return entry;
      }
      const label = marker ?? projection?.marker(chunk);
      if (label === null || label === undefined) {
        return entry;
      }
      let text = label;
      if (
        chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
        chunk.type === EventType.TEXT_MESSAGE_CHUNK
      ) {
        const messageKey = chunk.messageId ?? "current-text-message";
        text = shownMarkers.has(messageKey) ? "" : label;
        shownMarkers.add(messageKey);
      }
      return { ...entry, chunk: projectWithdrawnRunChunk(chunk, text) };
    });
  };
  return { projectEntries, hasRead: () => projection !== undefined };
};

const createRunLogReader = ({
  db,
  organizationId,
  runId,
  timingMode = "stored",
}: RunLogReaderOptions & {
  timingMode?: "stored" | "current";
}): Pick<StreamDurability, "read" | "snapshot"> => {
  const needsCurrentTiming = (chunks: readonly StreamChunk[]) =>
    timingMode === "current" && chunks.some(hasRunningChunkTiming);
  const loadHeader = async (tx: Transaction, includeReferences: boolean) =>
    await readRunLogHeaderOnTx({
      tx,
      organizationId,
      runId,
      includeReferences,
    });
  const unsettledTailAfter = (log: RunLogHeader) => {
    if (log?.closedAt !== null) {
      return undefined;
    }
    if (
      log.tailChunk?.type === EventType.TEXT_MESSAGE_END &&
      log.tailChunk.metadata !== undefined &&
      "turnTiming" in log.tailChunk.metadata
    ) {
      return log.nextSeq - 2n;
    }
    if (
      log.tailChunk?.type !== EventType.RUN_FINISHED &&
      log.tailChunk?.type !== EventType.RUN_ERROR
    ) {
      return undefined;
    }
    return log.tailTimingSeq === null
      ? log.nextSeq - 2n
      : BigInt(log.tailTimingSeq) - 1n;
  };
  const loadPage = async (
    after: bigint,
    projection: ReturnType<typeof createRunLogCopyProjection>,
  ) =>
    await db(async (tx) => {
      const log = await loadHeader(tx, !projection.hasRead());
      if (log === undefined) {
        return { entries: [], log };
      }
      const storedEntries = await tx
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
      const entries = await projection.projectEntries({
        entries: storedEntries,
        log,
      });
      if (!needsCurrentTiming(entries.map(({ chunk }) => chunk))) {
        return { entries, log };
      }
      // Historical receipts cannot anchor a new browser runtime. Read once
      // for this page, retaining durable offsets and all non-timing metadata.
      const timing = await readCurrentRunTiming({ tx, organizationId, runId });
      return {
        entries: entries.map((entry) => ({
          ...entry,
          chunk: refreshRunningTiming(entry.chunk, timing),
        })),
        log,
      };
    });

  return {
    async *read(offset, signal) {
      const projection = createRunLogCopyProjection();
      let after: bigint | null = 0n;
      if (offset === "now") {
        after = null;
      } else if (offset !== "-1") {
        after = offsetSequence(offset);
      }
      if (after === null) {
        const { log } = await loadPage(0n, projection);
        // "Now" excludes published history; the unsettled suffix still
        // belongs to the viewer because it has not passed the tail fence.
        after =
          unsettledTailAfter(log) ??
          (log === undefined ? 0n : log.nextSeq - 1n);
      }
      const deadline =
        Temporal.Now.instant().epochMilliseconds + FIRST_ENTRY_WAIT_MS;
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        // db-await-in-loop: tailing page walk; each read starts after the last yielded seq, a page holds at most READ_PAGE_SIZE rows, and the loop ends at the close marker, the not-found deadline, or the abort signal
        const { entries, log } = await loadPage(after, projection);
        for (const entry of entries) {
          // Final append precedes the transaction that stores the transcript
          // and closes the log. Hold an open tail terminal until that commit;
          // intermediate finishes release once the next iteration appends.
          const heldAfter = unsettledTailAfter(log);
          if (heldAfter !== undefined && entry.seq > heldAfter) {
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
        const { projectEntries } = createRunLogCopyProjection();
        const log = await loadHeader(tx, true);
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
            if (!needsCurrentTiming(result.map(({ chunk }) => chunk))) {
              return await projectEntries({
                entries: result,
                log,
              });
            }
            const timing = await readCurrentRunTiming({
              tx,
              organizationId,
              runId,
            });
            return await projectEntries({
              entries: result.map((entry) => ({
                ...entry,
                chunk: refreshRunningTiming(entry.chunk, timing),
              })),
              log,
            });
          }
        }
      }),
  };
};

// A reconnect replays at most 256 deltas or a 1 MiB suffix. Larger prefixes
// fold into one canonical SDK transcript snapshot, bounded by MAX_RUN_BYTES.
export const MAX_CATCHUP_CHUNKS = 256n;
export const MAX_CATCHUP_BYTES = 1024n * 1024n;

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
  const reader = createRunLogReader({
    db,
    organizationId,
    runId,
    timingMode: "current",
  });
  if (header === undefined) {
    return waitForStart
      ? {
          ...reader,
          resumeFrom: () => resumeOffset,
          append: () => panic("A rejoined chat run cannot produce"),
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
    throw new ChatRunLogOffsetBeyondTailError({
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
    append: () => panic("A rejoined chat run cannot produce"),
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
      const timingEnd = prefix.at(-1)?.chunk;
      if (
        timingEnd?.type === EventType.TEXT_MESSAGE_END &&
        timingEnd.metadata !== undefined &&
        "turnTiming" in timingEnd.metadata
      ) {
        // The terminal append precedes settlement. Replay the final timing
        // through the tail fence rather than compacting its placeholder.
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
  // The final batch is appended under the running fence. Finalize its timing
  // after settlement, in the same transaction that releases the log's tail.
  const timing = sql`(
    select ${messageTurnTiming({
      messageId: chatTurns.timingMessageId,
      threadId: chatTurns.threadId,
      fallbackTurnId: chatTurns.id,
    })}
    from ${chatTurns}
    where ${chatTurns.id} = ${turnId}
      and ${chatTurns.organizationId} = ${organizationId}
  )`;
  // audit: skip — derived metadata in the ephemeral log; transcript settlement is audited by its caller
  await tx
    .update(chatRunLogEntries)
    .set({
      chunk: sql`jsonb_set(${chatRunLogEntries.chunk}, '{metadata,turnTiming}', coalesce(${timing}, 'null'::jsonb))`,
    })
    .where(
      and(
        entryKey(organizationId, runId),
        eq(
          chatRunLogEntries.batchId,
          sql`(
          select batch_id from chat_run_log_entries
          where organization_id = ${organizationId} and run_id = ${runId}
          order by seq desc limit 1
        )`,
        ),
        sql`${chatRunLogEntries.chunk}->>'type' = ${EventType.TEXT_MESSAGE_END}`,
        sql`${chatRunLogEntries.chunk}->'metadata' ? 'turnTiming'`,
      ),
    );
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
