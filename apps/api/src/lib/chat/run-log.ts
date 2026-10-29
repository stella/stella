import { EventType, uiMessagesToWire } from "@tanstack/ai";
import type { StreamChunk, StreamDurability, UIMessage } from "@tanstack/ai";
import { panic, Result, TaggedError } from "better-result";
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
  chatRunTextStartSql,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionReferencesIn } from "@/api/lib/case-law/withdrawn-copy-projection";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import type {
  ChatRunCheckpointedReferenceState,
  ChatRunReferenceState,
  ChatRunRescanReferenceState,
  ChatRunTrackedReferenceState,
} from "@/api/lib/chat/run-log-reference-state";
import { createRunMessageRoles } from "@/api/lib/chat/run-log-roles";
import type { OpenRunMessage } from "@/api/lib/chat/run-log-roles";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { messageTurnTiming } from "@/api/lib/chat/turn-timing";
import { projectWithdrawnRunChunk } from "@/api/lib/chat/withdrawn-run-chunks";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
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
>;
type RunLogReferenceSummary =
  | { type: "legacy" }
  | ChatRunRescanReferenceState
  | ({ type: "checkpointed" } & RunLogResolvedReferences);

type RunLogHeaderOptions = Pick<
  RunLogReaderOptions,
  "organizationId" | "runId"
> & {
  tx: Transaction;
  includeReferences: boolean;
  restoreRolesAfter?: bigint | undefined;
};
const readRunLogHeaderOnTx = async ({
  tx,
  organizationId,
  runId,
  includeReferences,
  restoreRolesAfter,
}: RunLogHeaderOptions) =>
  (
    await tx
      .select({
        openMessages:
          restoreRolesAfter === undefined
            ? sql<OpenRunMessage[]>`'[]'::jsonb`
            : sql<OpenRunMessage[]>`to_jsonb(ARRAY(
          SELECT jsonb_build_object('messageId', started.chunk->>'messageId', 'role', started.chunk->>'role', 'current', started.seq = (
            SELECT latest.seq FROM chat_run_log_entries latest
            WHERE latest.organization_id = started.organization_id AND latest.run_id = started.run_id
              AND latest.seq <= ${restoreRolesAfter} AND ${chatRunTextStartSql(sql`latest.chunk`)}
            ORDER BY latest.seq DESC LIMIT 1
          )) FROM chat_run_log_entries started
          WHERE started.organization_id = ${chatRunLogs.organizationId} AND started.run_id = ${chatRunLogs.runId}
            AND started.seq <= ${restoreRolesAfter} AND ${chatRunTextStartSql(sql`started.chunk`)}
            AND started.text_boundary_initialization = 'recorded' AND (started.text_message_end_seq IS NULL OR started.text_message_end_seq > ${restoreRolesAfter}) ORDER BY started.seq LIMIT ${MAX_RUN_BYTES}
        ))`,
        closedAt: chatRunLogs.closedAt,
        nextSeq: chatRunLogs.nextSeq,
        bytesUsed: chatRunLogs.bytesUsed,
        subjectDecisionId: chatThreads.subjectDecisionId,
        referenceSummary: includeReferences
          ? sql<RunLogReferenceSummary>`CASE WHEN ${chatRunLogs.referenceSummary}->>'type' = 'checkpointed' THEN jsonb_build_object('type', 'checkpointed', 'through', ${chatRunLogs.referenceSummary}->'through', 'decisionIds', ${chatRunLogs.referenceSummary}->'decisionIds') ELSE ${chatRunLogs.referenceSummary} END`
          : sql<RunLogReferenceSummary | null>`null`,
        sourceContent: includeReferences
          ? sql`CASE WHEN octet_length(${chatMessages.content}::text) <= ${MAX_RUN_BYTES}::integer THEN ${chatMessages.content} ELSE NULL END`
          : sql`null`,
        sourceOverflow: includeReferences
          ? sql<boolean>`coalesce(octet_length(${chatMessages.content}::text) > ${MAX_RUN_BYTES}::integer, false)`
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

const TOOL_REFERENCES_NEED_HISTORY = {
  "awaiting-input": true,
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

const STRUCTURED_REFERENCES_NEED_HISTORY = {
  streaming: true,
  complete: false,
  error: false,
} as const satisfies Record<
  Extract<UIMessage["parts"][number], { type: "structured-output" }>["status"],
  boolean
>;

type FoldReferenceStateOptions = {
  state: ChatRunCheckpointedReferenceState;
  chunks: StreamChunk[];
  through: string;
};

const tryFoldReferenceState = ({
  state,
  chunks,
  through,
}: FoldReferenceStateOptions): ChatRunTrackedReferenceState => {
  const rescan = {
    type: "rescan-required",
    from: (BigInt(state.through) + 1n).toString(),
    through,
  } satisfies ChatRunRescanReferenceState;
  const { processor } = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  // Replaying only the bounded carry restores the SDK's transient shorthand
  // lanes too; initialMessages alone cannot resume a TEXT_MESSAGE_CHUNK lane.
  for (const message of state.messages) {
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
      } else {
        processor.processChunk({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: part.stepId ?? message.id,
          delta: part.content,
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
  const carry: ChatRunCheckpointedReferenceState["messages"] = [];
  for (const { id, role, parts } of messages) {
    if (
      role === "activity" ||
      parts.some(
        (part) =>
          (part.type === "tool-call" &&
            TOOL_REFERENCES_NEED_HISTORY[part.state]) ||
          (part.type === "structured-output" &&
            STRUCTURED_REFERENCES_NEED_HISTORY[part.status]),
      )
    ) {
      return rescan;
    }
    // Canonical decision identities fit in this suffix; long passage anchors
    // follow the identity and are discovered before the suffix advances.
    const suffix = parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("")
      .slice(-REFERENCE_TEXT_CARRY_CHARS);
    const kept: ChatRunCheckpointedReferenceState["messages"][number]["parts"] =
      suffix === "" ? [] : [{ type: "text", content: suffix }];
    const thinking = parts.findLast((part) => part.type === "thinking");
    if (thinking?.type === "thinking") {
      kept.push({
        type: "thinking",
        content: thinking.content.slice(-REFERENCE_TEXT_CARRY_CHARS),
        ...(thinking.stepId === undefined ? {} : { stepId: thinking.stepId }),
      });
    }
    carry.push({ id, role, parts: kept });
  }
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
    return rescan;
  }
  return next;
};

const REFERENCE_CHECKPOINT_FAILURE = failureSink({
  event: "chat.run_log.reference_checkpoint",
  expected: [],
});

// Reference capture is optional indexing; a processor failure must not reject
// a chunk accepted by the delivery log. Persisted reads rebuild the references.
const foldReferenceState = (
  options: FoldReferenceStateOptions,
): ChatRunTrackedReferenceState =>
  Result.try(() => tryFoldReferenceState(options)).match({
    ok: (state) => state,
    err: () => {
      observeFailure(
        new ChatRunLogError({
          message: "Chat run reference checkpoint requires reconstruction",
        }),
        { sink: REFERENCE_CHECKPOINT_FAILURE },
      );
      return {
        type: "rescan-required",
        from: (BigInt(options.state.through) + 1n).toString(),
        through: options.through,
      };
    },
  });

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
    case "rescan-required":
      return {
        type: "rescan-required",
        from: state.from,
        through: (firstSeq + BigInt(chunks.length) - 1n).toString(),
      };
    case "checkpointed":
      if (state.through !== (firstSeq - 1n).toString()) {
        return {
          type: "rescan-required",
          from: "1",
          through: (firstSeq + BigInt(chunks.length) - 1n).toString(),
        };
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

type StoredRunEntry = { seq: bigint; chunk: StreamChunk };

type ReadRunReferencesOptions = RunLogReaderOptions & {
  tx: Transaction;
  nextSeq: bigint;
  captureEntry?: ((entry: StoredRunEntry) => void) | undefined;
};

const readRunReferencesOnTx = async ({
  tx,
  organizationId,
  runId,
  nextSeq,
  captureEntry,
}: Omit<ReadRunReferencesOptions, "db">) => {
  const { processor } = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  const references = new Set<string>();
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
      captureEntry?.({ seq, chunk });
      processor.processChunk(chunk);
      for (const id of decisionReferencesIn(
        Object.fromEntries(
          Object.entries(chunk).filter(([key]) => key !== "delta"),
        ),
      )) {
        references.add(id);
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
      };
    }
  }
};

const createLiveRunReferences = () => {
  let state: ChatRunTrackedReferenceState = {
    type: "checkpointed",
    through: "0",
    decisionIds: [],
    messages: [],
  };
  return (entries: { chunk: StreamChunk; seq?: bigint; offset?: string }[]) => {
    const references = decisionReferencesIn(entries.map(({ chunk }) => chunk));
    switch (state.type) {
      case "checkpointed": {
        const final = entries.at(-1);
        state = foldReferenceState({
          state,
          chunks: entries.map(({ chunk }) => chunk),
          through: final?.seq?.toString() ?? final?.offset ?? state.through,
        });
        break;
      }
      case "rescan-required":
        break;
      default:
        state satisfies never;
        panic("Unknown live reference state");
    }
    if (state.type === "checkpointed") {
      for (const id of state.decisionIds) {
        references.add(id);
      }
    }
    return { decisionIds: references };
  };
};

type PrepareRunProjectionOptions = {
  log: RunLogHeader;
  tx: Transaction;
  captureEntry?: ReadRunReferencesOptions["captureEntry"];
};

const createRunLogCopyProjection = ({
  organizationId,
  runId,
}: Pick<RunLogReaderOptions, "organizationId" | "runId">) => {
  let rebuilt: RunLogResolvedReferences | undefined;
  const trackLiveReferences = createLiveRunReferences();
  let projection:
    Awaited<ReturnType<typeof readWithdrawnCopyProjection>> | undefined;
  let runMarker: string | null | undefined;
  const checkedReferences = new Set<string>();
  const roles = createRunMessageRoles();
  const shownMarkers = new Set<string>();
  let rolesRestored = false;
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
          log.referenceSummary?.type !== "checkpointed"
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
      const live = trackLiveReferences(entries);
      for (const id of live.decisionIds) {
        references.add(id);
      }
    } else {
      let resolved: RunLogResolvedReferences;
      switch (persisted.type) {
        case "legacy":
        case "rescan-required":
          if (
            rebuilt === undefined ||
            rebuilt.through !== (log.nextSeq - 1n).toString()
          ) {
            panic("Run references were not prepared for this header");
          }
          resolved = rebuilt;
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
      const attribution = roles.classify(chunk);
      switch (attribution.type) {
        case "unknown":
        case "authored":
          return entry;
        case "generated":
        case "protocol":
          break;
        default:
          attribution satisfies never;
          return panic("Unknown run message attribution");
      }
      if (marker === null) {
        return entry;
      }
      let text = marker;
      if (
        (chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
          chunk.type === EventType.TEXT_MESSAGE_CHUNK) &&
        attribution.type === "generated" &&
        attribution.identity.type === "known"
      ) {
        const messageKey = attribution.identity.messageId;
        text = shownMarkers.has(messageKey) ? "" : marker;
        shownMarkers.add(messageKey);
      }
      return { ...entry, chunk: projectWithdrawnRunChunk(chunk, text) };
    });
  };
  return {
    restoreRoles(log: RunLogHeader) {
      if (rolesRestored || log === undefined) {
        return;
      }
      roles.restore(log.openMessages);
      rolesRestored = true;
    },
    async forHeader({ log, tx, captureEntry }: PrepareRunProjectionOptions) {
      if (log !== undefined && log.referenceSummary !== null) {
        const summary = log.referenceSummary;
        switch (summary.type) {
          case "legacy":
          case "rescan-required":
            if (
              summary.type === "rescan-required" &&
              summary.through !== (log.nextSeq - 1n).toString()
            ) {
              throw new ChatRunLogError({
                message: "Chat run log reference summary is incomplete",
              });
            }
            if (log.bytesUsed > BigInt(MAX_RUN_BYTES)) {
              throw new ChatRunLogError({
                message: "Chat run log exceeds its size limit",
              });
            }
            if (
              captureEntry !== undefined ||
              rebuilt?.through !== (log.nextSeq - 1n).toString()
            ) {
              rebuilt = await readRunReferencesOnTx({
                tx,
                organizationId,
                runId,
                nextSeq: log.nextSeq,
                captureEntry,
              });
            }
            break;
          case "checkpointed":
            break;
          default:
            summary satisfies never;
            panic("Unknown run reference state");
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

type RunLogSnapshotOptions = RunLogReaderOptions & {
  timingMode: "stored" | "current";
};

const readRunLogSnapshot = async ({
  db,
  organizationId,
  runId,
  timingMode,
}: RunLogSnapshotOptions) =>
  await db(async (tx) => {
    const projection = createRunLogCopyProjection({
      organizationId,
      runId,
    });
    const log = await readRunLogHeaderOnTx({
      tx,
      organizationId,
      runId,
      includeReferences: true,
    });
    if (log === undefined) {
      return [];
    }
    const captured: StoredRunEntry[] = [];
    const projectEntries = await projection.forHeader({
      log,
      tx,
      captureEntry: (entry) => {
        captured.push(entry);
      },
    });
    const timing =
      timingMode === "current"
        ? await readCurrentRunTiming({ tx, organizationId, runId })
        : null;
    switch (log.referenceSummary?.type) {
      case "legacy":
      case "rescan-required": {
        const projected = await projectEntries(
          captured.map((entry) => ({
            ...entry,
            chunk:
              timing === null
                ? entry.chunk
                : refreshRunningTiming(entry.chunk, timing),
          })),
        );
        return projected.map(({ seq, chunk }) => ({
          offset: seq.toString(),
          chunk,
        }));
      }
      case "checkpointed":
      case undefined:
        break;
      default:
        log.referenceSummary satisfies never;
        return panic("Unknown snapshot reference state");
    }
    const result: { offset: string; chunk: StreamChunk }[] = [];
    let after = 0n;
    for (;;) {
      const page = await readCursorPage(
        tx
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
          .orderBy(asc(chatRunLogEntries.seq)),
        {
          limit: READ_PAGE_SIZE - 1,
          cursorForItem: ({ seq }) => seq.toString(),
        },
      );
      const entries = page.items;
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
      if (page.nextCursor === null) {
        if (after !== log.nextSeq - 1n) {
          throw new ChatRunLogError({
            message: "Chat run log changed during snapshot",
          });
        }
        return result;
      }
    }
  });

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
  const loadHeader = async (
    tx: Transaction,
    includeReferences: boolean,
    restoreRolesAfter?: bigint,
  ) =>
    await readRunLogHeaderOnTx({
      tx,
      organizationId,
      runId,
      includeReferences,
      restoreRolesAfter,
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
    restoreRoles,
  }: {
    after: bigint;
    projection: ReturnType<typeof createRunLogCopyProjection>;
    includeReferences: boolean;
    restoreRoles: boolean;
  }) =>
    await db(async (tx) => {
      const log = await loadHeader(
        tx,
        includeReferences,
        restoreRoles ? after : undefined,
      );
      projection.restoreRoles(log);
      if (log === undefined) {
        return { entries: [], log };
      }
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
      if (storedEntries.length === 0) {
        return { entries: [], log };
      }
      const projectEntries = await projection.forHeader({ log, tx });
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
      let restoreRoles = true;
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
          restoreRoles,
        });
        if (log !== undefined) {
          restoreRoles = false;
        }
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
      await readRunLogSnapshot({ db, organizationId, runId, timingMode }),
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
