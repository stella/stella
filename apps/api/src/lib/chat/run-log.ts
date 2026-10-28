import { EventType, uiMessagesToWire } from "@tanstack/ai";
import type { StreamChunk, StreamDurability, UIMessage } from "@tanstack/ai";
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
  CHAT_RUN_REFERENCE_STATE_MAX_BYTES,
  chatMessages,
  chatRunLogEntries,
  chatRunLogs,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionReferencesIn } from "@/api/lib/case-law/withdrawn-copy-projection";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import type {
  ChatRunCheckpointedReferenceState,
  ChatRunReferenceState,
} from "@/api/lib/chat/run-log-reference-state";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { messageTurnTiming } from "@/api/lib/chat/turn-timing";
import { projectWithdrawnRunChunk } from "@/api/lib/chat/withdrawn-run-chunks";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { emitChatRunLogMetric } from "@/api/lib/observability/request-metrics";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

const MAX_CHUNK_BYTES = 1024 * 1024;
export const MAX_RUN_BYTES = 32 * MAX_CHUNK_BYTES;
export const READ_PAGE_SIZE = 256;
const REFERENCE_TEXT_CARRY_CHARS = 256;
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

type RunLogResolvedReferences = Pick<
  ChatRunCheckpointedReferenceState,
  "through" | "decisionIds"
> & { userMessageIds: string[] };
type RunLogReferenceSummary =
  { type: "legacy" } | ({ type: "checkpointed" } & RunLogResolvedReferences);

type RunLogHeaderOptions = Pick<
  RunLogReaderOptions,
  "organizationId" | "runId"
> & {
  tx: Transaction;
  includeReferences: boolean;
};
const sourceReadBudget = sql`CASE WHEN ${chatRunLogs.referenceSummary}->>'type' = 'legacy' THEN ${MAX_RUN_BYTES}::integer ELSE ${MAX_CHUNK_BYTES}::integer END`;
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
        bytesUsed: chatRunLogs.bytesUsed,
        subjectDecisionId: chatThreads.subjectDecisionId,
        referenceSummary: includeReferences
          ? sql<RunLogReferenceSummary>`CASE WHEN ${chatRunLogs.referenceSummary}->>'type' = 'legacy' THEN jsonb_build_object('type', 'legacy') ELSE jsonb_build_object('type', 'checkpointed', 'through', ${chatRunLogs.referenceSummary}->'through', 'decisionIds', ${chatRunLogs.referenceSummary}->'decisionIds', 'userMessageIds', jsonb_path_query_array(${chatRunLogs.referenceSummary}, '$.messages[*] ? (@.role == "user").id')) END`
          : sql<RunLogReferenceSummary | null>`null`,
        sourceContent: includeReferences
          ? sql`CASE WHEN octet_length(${chatMessages.content}::text) <= ${sourceReadBudget} THEN ${chatMessages.content} ELSE NULL END`
          : sql`null`,
        sourceOverflow: includeReferences
          ? sql<boolean>`coalesce(octet_length(${chatMessages.content}::text) > ${sourceReadBudget}, false)`
          : sql<boolean>`false`,
        tailType: sql<string | null>`${chatRunLogEntries.chunk}->>'type'`,
        tailHasTiming: sql<boolean>`coalesce(${chatRunLogEntries.chunk}->'metadata' ? 'turnTiming', false)`,
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

const CARRY_TOOL_ARGUMENTS = {
  "awaiting-input": false,
  "input-streaming": true,
  "input-complete": false,
  "approval-requested": false,
  "approval-responded": false,
  complete: false,
  error: false,
} as const satisfies Record<
  Extract<UIMessage["parts"][number], { type: "tool-call" }>["state"],
  boolean
>;

type FoldReferenceStateOptions = {
  state: ChatRunCheckpointedReferenceState;
  chunks: StreamChunk[];
  through: string;
};

const foldReferenceState = ({
  state,
  chunks,
  through,
}: FoldReferenceStateOptions): ChatRunCheckpointedReferenceState => {
  const { processor } = createStreamMessageCapture({
    initialMessages: state.messages.filter(({ role }) => role === "activity"),
    capture: (message) => message,
  });
  // Replaying only the bounded carry restores the SDK's transient shorthand
  // lanes too; initialMessages alone cannot resume a TEXT_MESSAGE_CHUNK lane.
  for (const message of state.messages) {
    if (message.role === "activity") {
      continue;
    }
    processor.processChunk({
      type: EventType.TEXT_MESSAGE_START,
      messageId: message.id,
      role: message.role,
    });
    for (const part of message.parts) {
      if (part.type === "text") {
        processor.processChunk({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: message.id,
          delta: part.content,
        });
      } else if (
        part.type === "structured-output" &&
        part.status === "streaming"
      ) {
        processor.processChunk({
          type: EventType.CUSTOM,
          name: "structured-output.start",
          value: { messageId: message.id },
        });
        processor.processChunk({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: message.id,
          delta: part.raw,
        });
      } else if (part.type === "thinking") {
        processor.processChunk({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: part.stepId ?? message.id,
          delta: part.content,
        });
      } else if (part.type === "tool-call") {
        processor.processChunk({
          type: EventType.TOOL_CALL_START,
          parentMessageId: message.id,
          toolCallId: part.id,
          toolCallName: part.name,
        });
        processor.processChunk({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: part.id,
          delta: part.arguments,
        });
      }
    }
  }
  const metadata = chunks.map((chunk) =>
    Object.fromEntries(
      Object.entries(chunk).filter(([key]) => key !== "delta"),
    ),
  );
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  const messages = processor.getMessages();
  const text = messages.map(({ parts }) =>
    parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join(""),
  );
  const decisionIds = [
    ...new Set([
      ...state.decisionIds,
      ...decisionReferencesIn([metadata, messages, text]),
    ]),
  ];
  const carry = messages.map(({ id, role, parts }) => {
    if (role === "activity") {
      return { id, role, parts };
    }
    // Canonical decision identities fit in this suffix; long passage anchors
    // follow the identity and are discovered before the suffix advances.
    const suffix = parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("")
      .slice(-REFERENCE_TEXT_CARRY_CHARS);
    const kept: UIMessage["parts"] =
      suffix === "" ? [] : [{ type: "text", content: suffix }];
    for (const part of parts) {
      if (part.type === "structured-output") {
        switch (part.status) {
          case "streaming":
            kept.push({
              type: "structured-output",
              status: part.status,
              raw: part.raw,
            });
            break;
          case "complete":
          case "error":
            break;
          default:
            part satisfies never;
            panic("Unknown structured output carry state");
        }
      }
    }
    const thinking = parts.findLast((part) => part.type === "thinking");
    if (thinking?.type === "thinking") {
      kept.push({
        type: "thinking",
        content: thinking.content.slice(-REFERENCE_TEXT_CARRY_CHARS),
        ...(thinking.stepId === undefined ? {} : { stepId: thinking.stepId }),
      });
    }
    for (const part of parts) {
      if (part.type === "tool-call" && CARRY_TOOL_ARGUMENTS[part.state]) {
        kept.push({
          type: "tool-call",
          id: part.id,
          name: part.name,
          state: part.state,
          arguments: part.arguments,
        });
      }
    }
    return { id, role, parts: kept };
  });
  const next = {
    type: "checkpointed",
    through,
    decisionIds,
    messages: carry,
  } satisfies ChatRunCheckpointedReferenceState;
  // JSONB's text adds spacing. Reserve half of the database ceiling so both
  // wire and stored representations remain bounded without truncating IDs.
  if (
    Buffer.byteLength(JSON.stringify(next)) >
    CHAT_RUN_REFERENCE_STATE_MAX_BYTES / 2
  ) {
    throw new ChatRunLogError({
      message: "Chat run log reference summary exceeds its size limit",
    });
  }
  return next;
};

type NextRunReferenceStateOptions = {
  state: ChatRunReferenceState;
  chunks: StreamChunk[];
  firstSeq: bigint;
};
const nextRunReferenceState = ({
  state,
  chunks,
  firstSeq,
}: NextRunReferenceStateOptions): ChatRunReferenceState => {
  switch (state.type) {
    case "legacy":
      return { type: "legacy" };
    case "checkpointed":
      if (state.through !== (firstSeq - 1n).toString()) {
        throw new ChatRunLogError({
          message: "Chat run log reference summary is incomplete",
        });
      }
      return foldReferenceState({
        state,
        chunks,
        through: (firstSeq + BigInt(chunks.length) - 1n).toString(),
      });
    default:
      state satisfies never;
      return panic("Unknown run reference state");
  }
};

type ReadLegacyRunReferencesOptions = RunLogReaderOptions & {
  tx: Transaction;
  nextSeq: bigint;
};

const readLegacyRunReferencesOnTx = async ({
  tx,
  organizationId,
  runId,
  nextSeq,
}: Omit<ReadLegacyRunReferencesOptions, "db">) => {
  const { processor } = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  const references = new Set<string>();
  const authoredSequences = new Set<string>();
  let currentRole: string | undefined;
  let after = 0n;
  let bytes = 0;
  for (;;) {
    const page = await readCursorPage(
      tx
        .select({ seq: chatRunLogEntries.seq, chunk: chatRunLogEntries.chunk })
        .from(chatRunLogEntries)
        .where(
          and(
            entryKey(organizationId, runId),
            gt(chatRunLogEntries.seq, after),
            lt(chatRunLogEntries.seq, nextSeq),
          ),
        )
        .orderBy(asc(chatRunLogEntries.seq)),
      {
        limit: READ_PAGE_SIZE - 1,
        cursorForItem: ({ seq }) => seq.toString(),
      },
    );
    for (const { seq, chunk } of page.items) {
      if (seq !== after + 1n) {
        throw new ChatRunLogError({
          message: "Chat run log changed during snapshot",
        });
      }
      bytes += chunkBytes(chunk);
      if (bytes > MAX_RUN_BYTES) {
        throw new ChatRunLogError({
          message: "Chat run log exceeds its size limit",
        });
      }
      processor.processChunk(chunk);
      for (const id of decisionReferencesIn(
        Object.fromEntries(
          Object.entries(chunk).filter(([key]) => key !== "delta"),
        ),
      )) {
        references.add(id);
      }
      if (chunk.type === EventType.TEXT_MESSAGE_START) {
        currentRole = chunk.role ?? "assistant";
      } else if (
        chunk.type === EventType.TEXT_MESSAGE_CHUNK &&
        chunk.role !== undefined
      ) {
        currentRole = chunk.role;
      }
      if (currentRole === "user") {
        authoredSequences.add(seq.toString());
      }
      if (chunk.type === EventType.TEXT_MESSAGE_END) {
        currentRole = undefined;
      }
      after = seq;
    }
    if (page.nextCursor === null) {
      if (after !== nextSeq - 1n) {
        throw new ChatRunLogError({
          message: "Chat run log changed during snapshot",
        });
      }
      const messages = processor.getMessages();
      for (const id of decisionReferencesIn([
        messages,
        messages.map(({ parts }) =>
          parts
            .flatMap((part) => (part.type === "text" ? [part.content] : []))
            .join(""),
        ),
      ])) {
        references.add(id);
      }
      return {
        through: after.toString(),
        decisionIds: [...references],
        userMessageIds: messages
          .filter(({ role }) => role === "user")
          .map(({ id }) => id),
        authoredSequences,
      };
    }
  }
};

const createRunLogCopyProjection = ({
  organizationId,
  runId,
}: Pick<RunLogReaderOptions, "organizationId" | "runId">) => {
  let legacy:
    | (RunLogResolvedReferences & { authoredSequences: ReadonlySet<string> })
    | undefined;
  let liveState: ChatRunCheckpointedReferenceState = {
    type: "checkpointed",
    through: "0",
    decisionIds: [],
    messages: [],
  };
  let projection:
    Awaited<ReturnType<typeof readWithdrawnCopyProjection>> | undefined;
  let runMarker: string | null | undefined;
  const checkedReferences = new Set<string>();
  const userMessageIds = new Set<string>();
  let currentRole: string | undefined;
  const shownMarkers = new Set<string>();
  const isAuthoredEntry = (chunk: StreamChunk) => {
    if (chunk.type === EventType.TEXT_MESSAGE_START) {
      currentRole = chunk.role ?? "assistant";
      if (currentRole === "user") {
        userMessageIds.add(chunk.messageId);
      }
    } else if (
      chunk.type === EventType.TEXT_MESSAGE_CHUNK &&
      chunk.role !== undefined
    ) {
      currentRole = chunk.role;
      if (chunk.role === "user" && chunk.messageId !== undefined) {
        userMessageIds.add(chunk.messageId);
      }
    }
    const authored =
      currentRole === "user" ||
      ((chunk.type === EventType.TEXT_MESSAGE_START ||
        chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
        chunk.type === EventType.TEXT_MESSAGE_END ||
        chunk.type === EventType.TEXT_MESSAGE_CHUNK) &&
        chunk.messageId !== undefined &&
        userMessageIds.has(chunk.messageId));
    if (chunk.type === EventType.TEXT_MESSAGE_END) {
      currentRole = undefined;
    }
    return authored;
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
    if (entries.length === 0) {
      return entries;
    }
    if (log === undefined) {
      panic("Run log projection requires its header");
    }
    if (log.sourceOverflow) {
      throw new ChatRunLogError({
        message:
          log.referenceSummary?.type === "legacy"
            ? "Chat run log exceeds its size limit"
            : "Chat run log source exceeds its size limit",
      });
    }
    const persisted = log.referenceSummary;
    const references = decisionReferencesIn([
      { subjectDecisionId: log.subjectDecisionId },
      log.sourceContent,
    ]);
    if (persisted === null) {
      const final = entries.at(-1);
      liveState = foldReferenceState({
        state: liveState,
        chunks: entries.map(({ chunk }) => chunk),
        through: final?.seq?.toString() ?? final?.offset ?? liveState.through,
      });
      for (const id of liveState.decisionIds) {
        references.add(id);
      }
      for (const message of liveState.messages) {
        if (message.role === "user") {
          userMessageIds.add(message.id);
        }
      }
    } else {
      let resolved: RunLogResolvedReferences;
      switch (persisted.type) {
        case "legacy":
          if (
            legacy === undefined ||
            legacy.through !== (log.nextSeq - 1n).toString()
          ) {
            panic("Legacy run references were not prepared for this header");
          }
          resolved = legacy;
          break;
        case "checkpointed":
          resolved = persisted;
          break;
        default:
          persisted satisfies never;
          return panic("Unknown run reference summary");
      }
      if (resolved.through !== (log.nextSeq - 1n).toString()) {
        throw new ChatRunLogError({
          message: "Chat run log reference summary is incomplete",
        });
      }
      for (const messageId of resolved.userMessageIds) {
        userMessageIds.add(messageId);
      }
      for (const id of resolved.decisionIds) {
        references.add(id);
      }
    }
    const source = { decisionId: [...references] };
    if (
      projection === undefined ||
      [...references].some((id) => !checkedReferences.has(id))
    ) {
      projection = await readWithdrawnCopyProjection({
        values: source,
        decisionIds: [...checkedReferences],
      });
      for (const id of references) {
        checkedReferences.add(id);
      }
    }
    runMarker ??= projection.marker(source, log.subjectDecisionId);
    const marker = runMarker;
    return entries.map((entry) => {
      const chunk = entry.chunk;
      const sequence = entry.seq?.toString() ?? entry.offset;
      if (
        isAuthoredEntry(chunk) ||
        (sequence !== undefined && legacy?.authoredSequences.has(sequence))
      ) {
        return entry;
      }
      if (marker === null) {
        return entry;
      }
      let text = marker;
      if (
        chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
        chunk.type === EventType.TEXT_MESSAGE_CHUNK
      ) {
        const messageKey = chunk.messageId ?? "current-text-message";
        text = shownMarkers.has(messageKey) ? "" : marker;
        shownMarkers.add(messageKey);
      }
      return { ...entry, chunk: projectWithdrawnRunChunk(chunk, text) };
    });
  };
  return {
    async forHeader({ log, tx }: { log: RunLogHeader; tx: Transaction }) {
      if (log?.referenceSummary?.type === "legacy") {
        if (log.bytesUsed > BigInt(MAX_RUN_BYTES)) {
          throw new ChatRunLogError({
            message: "Chat run log exceeds its size limit",
          });
        }
        if (legacy?.through !== (log.nextSeq - 1n).toString()) {
          legacy = await readLegacyRunReferencesOnTx({
            tx,
            organizationId,
            runId,
            nextSeq: log.nextSeq,
          });
        }
      }
      return async <
        T extends { chunk: StreamChunk; seq?: bigint; offset?: string },
      >(
        entries: T[],
      ) => await projectEntries({ entries, log });
    },
  };
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
    if (log.tailType === EventType.TEXT_MESSAGE_END && log.tailHasTiming) {
      return log.nextSeq - 2n;
    }
    if (
      log.tailType !== EventType.RUN_FINISHED &&
      log.tailType !== EventType.RUN_ERROR
    ) {
      return undefined;
    }
    return log.tailTimingSeq === null
      ? log.nextSeq - 2n
      : BigInt(log.tailTimingSeq) - 1n;
  };
  const loadPage = async ({
    after,
    projection,
    includeReferences,
  }: {
    after: bigint;
    projection: ReturnType<typeof createRunLogCopyProjection>;
    includeReferences: boolean;
  }) =>
    await db(async (tx) => {
      const log = await loadHeader(tx, includeReferences);
      if (log === undefined) {
        return { entries: [], log };
      }
      const projectEntries = await projection.forHeader({ log, tx });
      // Settlement releases the terminal suffix; projection state advances only for delivered entries.
      const heldAfter = unsettledTailAfter(log);
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
            lt(
              chatRunLogEntries.seq,
              heldAfter === undefined ? log.nextSeq : heldAfter + 1n,
            ),
          ),
        )
        .orderBy(asc(chatRunLogEntries.seq))
        .limit(READ_PAGE_SIZE);
      const entries = await projectEntries(storedEntries);
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
      const projection = createRunLogCopyProjection({
        organizationId,
        runId,
      });
      let after: bigint | null = 0n;
      if (offset === "now") {
        after = null;
      } else if (offset !== "-1") {
        after = offsetSequence(offset);
      }
      if (after === null) {
        const log = await db(async (tx) => await loadHeader(tx, false));
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
        const { entries, log } = await loadPage({
          after,
          projection,
          includeReferences: offset !== "now",
        });
        for (const entry of entries) {
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
        const projection = createRunLogCopyProjection({
          organizationId,
          runId,
        });
        const log = await loadHeader(tx, true);
        if (log === undefined) {
          return [];
        }
        const projectEntries = await projection.forHeader({ log, tx });
        const timing =
          timingMode === "current"
            ? await readCurrentRunTiming({ tx, organizationId, runId })
            : null;
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
          const projected = await projectEntries(
            entries.map((entry) => ({
              ...entry,
              chunk:
                timing === null
                  ? entry.chunk
                  : refreshRunningTiming(entry.chunk, timing),
            })),
          );
          for (const entry of projected) {
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

// Gaps above either catch-up bound fold into a canonical SDK snapshot.
// Smaller cursor gaps read only their indexed suffix; now tails live delivery.
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
  const cursor = (() => {
    if (resumeOffset === "now") {
      return null;
    }
    if (resumeOffset === "-1") {
      return 0n;
    }
    return offsetSequence(resumeOffset);
  })();
  const header = await db(async (tx) =>
    (
      await tx
        .select({
          closedAt: chatRunLogs.closedAt,
          nextSeq: chatRunLogs.nextSeq,
          bytesUsed: chatRunLogs.bytesUsed,
          suffixBytes:
            cursor === null || cursor === 0n
              ? sql<string>`'0'`
              : sql<string>`CASE
                  WHEN ${chatRunLogs.bytesUsed} > ${MAX_CATCHUP_BYTES}::bigint
                    AND ${chatRunLogs.nextSeq} - 1 - ${cursor}::bigint <= ${MAX_CATCHUP_CHUNKS}::bigint
                  THEN (SELECT coalesce(sum(gap.bytes), 0)::text FROM (
                    SELECT octet_length(${chatRunLogEntries.chunk}::text) AS bytes
                    FROM ${chatRunLogEntries}
                    WHERE ${entryKey(organizationId, runId)}
                      AND ${chatRunLogEntries.seq} > ${cursor}::bigint
                      AND ${chatRunLogEntries.seq} < ${chatRunLogs.nextSeq}
                    ORDER BY ${chatRunLogEntries.seq}
                    LIMIT ${MAX_CATCHUP_CHUNKS + 1n}
                  ) gap)
                  ELSE '0'
                END`,
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
  const after = cursor ?? header.nextSeq - 1n;
  if (after >= header.nextSeq) {
    throw new ChatRunLogOffsetBeyondTailError({
      message: "Chat run log offset is beyond the stored tail",
    });
  }
  // Only small gaps need a byte probe, bounded to one catch-up page in the
  // header statement so recent reconnects keep a constant query count.
  const compact =
    header.nextSeq - 1n - after > MAX_CATCHUP_CHUNKS ||
    (cursor === 0n ? header.bytesUsed : BigInt(header.suffixBytes)) >
      MAX_CATCHUP_BYTES;
  return {
    ...reader,
    resumeFrom: () => resumeOffset,
    append: () => panic("A rejoined chat run cannot produce"),
    close: async () => {
      // A viewer closes delivery without closing the producer log.
    },
    async *read(offset, signal) {
      if (!compact || offset === "now") {
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

const assertRunLogOwner = async ({
  tx,
  execution,
  organizationId,
  runId,
}: Pick<ChatRunLogOptions, "execution" | "organizationId" | "runId"> & {
  tx: Transaction;
}) => {
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
        await assertRunLogOwner({ tx, execution, organizationId, runId });
        await tx
          .insert(chatRunLogs)
          .values({
            organizationId,
            runId,
            turnId: execution.id,
            referenceSummary: {
              type: "checkpointed",
              through: "0",
              decisionIds: [],
              messages: [],
            },
          })
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
        const [reference] = await tx
          .select({ state: chatRunLogs.referenceSummary })
          .from(chatRunLogs)
          .where(logKey(organizationId, runId))
          .limit(1);
        const previous =
          reference?.state ??
          panic("Locked run log reference state disappeared");
        const referenceSummary = nextRunReferenceState({
          state: previous,
          chunks,
          firstSeq: log.nextSeq,
        });
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
          .set({
            nextSeq: first + BigInt(chunks.length),
            bytesUsed: nextBytes,
            referenceSummary,
          })
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
        await assertRunLogOwner({ tx, execution, organizationId, runId });
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
            referenceSummary: {
              type: "checkpointed",
              through: "0",
              decisionIds: [],
              messages: [],
            },
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
