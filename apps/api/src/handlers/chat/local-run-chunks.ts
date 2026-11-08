import { EventSchema } from "@ag-ui/core/schemas";
import {
  type AdapterYieldChunk,
  EventType,
  type ModelMessage,
  normalizeStreamChunk,
  type RunAgentResumeItem,
} from "@tanstack/ai";
import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { HARNESS_CONTINUATION_EVENT } from "@stll/agent-engine";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import { AGENT_HARNESSES } from "@stll/api-contract/agent-harness";
import {
  CHAT_TOOL_EXECUTOR,
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
} from "@stll/api-contract/chat";
import { RUN_OUTPUT_FILE_EXTENSIONS } from "@stll/api-contract/chat-file-types";
import {
  CHAT_LOCAL_RUN_COMPUTER_EVENT,
  CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY,
  CHAT_LOCAL_RUN_FILES_METADATA_KEY,
  CHAT_LOCAL_RUN_FILES_NOT_SHARED_METADATA_KEY,
  CHAT_LOCAL_RUN_LIMIT_METADATA_KEY,
  type ChatLocalRunComputerEvent,
  chatLocalRunContextSchema,
  type ChatLocalRunFile,
  type ChatLocalRunHarness,
  type ChatLocalRunLimit,
  chatLocalRunLimitSchema,
} from "@stll/api-contract/chat-run-target";
import {
  type DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_OUTPUT_EVENT,
  type DesktopRunnerApprovalMode,
  type DesktopRunnerDesktopMessage,
  desktopRunnerDesktopMessageSchema,
  type DesktopRunnerHarnessReport,
  desktopRunnerOutputEventSchema,
} from "@stll/api-contract/desktop-runner";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  questionPauseOf,
  questionReplyOf,
} from "@/api/lib/desktop-runner/chunk";
import type {
  DesktopRunnerControl,
  DesktopRunnerControlError,
  LocalRunAttachment,
  QueueCommandOutcome,
} from "@/api/lib/desktop-runner/control";
import type { DesktopRunnerRunBell } from "@/api/lib/desktop-runner/doorbell";
import type {
  ChatRunForRequest,
  DesktopRunnerRunView,
  RunOwner,
} from "@/api/lib/desktop-runner/store";
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { toUserFileUrl } from "@/api/lib/user-files/types";

/**
 * A chat turn run by a coding-agent harness on the member's computer, as a
 * source of the same stream chunks a cloud turn yields. The desktop maps its
 * harness's events to TanStack chunks (`harnessEventsToChunks`) and the
 * gateway stores them in order; this reads them back after the last position
 * the turn consumed and hands them to the shared turn pipeline, so storing,
 * the run log, rejoining, stopping and approvals work as for a cloud turn.
 */

type ApprovalDecision = (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number];

/** What the chunk source reads and commands through. */
type LocalRunControl = Pick<
  DesktopRunnerControl,
  | "answerApproval"
  | "answerQuestion"
  | "interruptRun"
  | "readChatRunForRequest"
  | "readChatRunSession"
  | "readEvents"
  | "readRun"
  | "readRunOutputFile"
  | "recordChatReadSeq"
  | "startRun"
>;

/** The computer and harness a new turn was routed to before it started. */
type LocalRunDestination = {
  desktopId: string;
  harness: ChatLocalRunHarness;
  harnessVersion: string;
  model: string;
  approvals: DesktopRunnerApprovalMode;
};

export type LocalRunContext = {
  control: LocalRunControl;
  runBell: DesktopRunnerRunBell;
  owner: RunOwner;
  chatThreadId: SafeId<"chatThread">;
  /** Workspaces the run's MCP token may reach. */
  workspaceIds: readonly SafeId<"workspace">[];
  mcp: { serverName: string; url: string };
  /** How long a reader waits for a ring before it reads again. */
  pollMs?: number;
};

type LocalRunStreamInput = {
  /** The chat run this attempt answers; every run event carries it. */
  chatRunId: string;
  /**
   * The chat turn that reads the run. The run lives as long as the turn holds
   * it; a resumed turn answers only the run it started.
   */
  chatTurnId: SafeId<"chatTurn">;
  /** The thread history, as the cloud model would receive it. */
  messages: readonly ModelMessage[];
  /** The system prompt the cloud model would receive. */
  instructions: string;
  /**
   * The answer to the approval or blocking question the run paused for;
   * absent on a new turn.
   */
  resume: readonly RunAgentResumeItem[] | undefined;
  /**
   * The turn's own cut: a stop on any API task, its deadline, a lost owner or
   * a failed production. It interrupts the run on the computer.
   */
  abortSignal: AbortSignal;
};

/** A chat turn bound to a computer: started on a new turn, continued on a resume. */
export type LocalChatRun = {
  readonly harness: ChatLocalRunHarness;
  /** The same run, copying these files into its folder before it starts. */
  readonly withAttachments: (
    attachments: readonly LocalRunAttachment[],
  ) => LocalChatRun;
  readonly stream: (
    input: LocalRunStreamInput,
  ) => AsyncIterable<PublicStreamChunk>;
};

const DEFAULT_POLL_MS = 1000;

const nowMs = () => Temporal.Now.instant().epochMilliseconds;
const EVENT_PAGE = 200;

/** Why a local turn could not go on, as the code its run error carries. */
type LocalRunFailure =
  | typeof AI_FAILURE_CODES.local_runner_needs_login
  | typeof AI_FAILURE_CODES.local_runner_limit_reached
  | typeof AI_FAILURE_CODES.local_runner_unavailable
  | typeof AI_FAILURE_CODES.local_runner_turn_too_large;

const FAILURE_MESSAGE = {
  [AI_FAILURE_CODES.local_runner_needs_login]:
    "The harness on the computer needs a sign-in.",
  [AI_FAILURE_CODES.local_runner_limit_reached]:
    "The harness on the computer reached its usage limit.",
  [AI_FAILURE_CODES.local_runner_unavailable]:
    "The computer stopped running the turn.",
  [AI_FAILURE_CODES.local_runner_turn_too_large]:
    "The conversation is too long to hand to the computer.",
} as const satisfies Record<LocalRunFailure, string>;

type StoredOutcome = Extract<
  DesktopRunnerDesktopMessage,
  { type: typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished }
>["outcome"];

/**
 * How a finished run ends the chat turn. A failure the member can act on
 * keeps its own code; an interruption ends the turn as stopped.
 */
const LOCAL_RUN_OUTCOME = {
  completed: { type: "completed" },
  interrupted: { type: "stopped" },
  cancelled: { type: "stopped" },
  failed: { type: "failed", code: null },
  limit_reached: {
    type: "failed",
    code: AI_FAILURE_CODES.local_runner_limit_reached,
  },
  needs_login: {
    type: "failed",
    code: AI_FAILURE_CODES.local_runner_needs_login,
  },
} as const satisfies Record<
  StoredOutcome,
  | { type: "completed" }
  | { type: "stopped" }
  | { type: "failed"; code: LocalRunFailure | null }
>;

type RejectReason = Extract<
  DesktopRunnerDesktopMessage,
  { type: typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.runRejected }
>["reason"];

/** Why the computer refused the run, as the turn's failure. */
const LOCAL_RUN_REJECTION = {
  harness_needs_login: AI_FAILURE_CODES.local_runner_needs_login,
  harness_limited: AI_FAILURE_CODES.local_runner_limit_reached,
  harness_not_installed: AI_FAILURE_CODES.local_runner_unavailable,
  harness_unsupported: AI_FAILURE_CODES.local_runner_unavailable,
  harness_unavailable: AI_FAILURE_CODES.local_runner_unavailable,
  harness_version_unavailable: AI_FAILURE_CODES.local_runner_unavailable,
  model_unavailable: AI_FAILURE_CODES.local_runner_unavailable,
  policy_unsupported: AI_FAILURE_CODES.local_runner_unavailable,
  at_capacity: AI_FAILURE_CODES.local_runner_unavailable,
  run_too_large: AI_FAILURE_CODES.local_runner_turn_too_large,
  unknown_run: AI_FAILURE_CODES.local_runner_unavailable,
} as const satisfies Record<RejectReason, LocalRunFailure>;

/** A stored chunk as the turn pipeline folds it. */
const isPublicStreamChunk = (value: unknown): value is PublicStreamChunk =>
  isRecord(value) && EventSchema.safeParse(value).success;

/**
 * The decision an answered approval sends to the harness. A chat answer is
 * `true`/`false` or `{ approved, scope }`; approving for the session needs
 * the explicit `scope: "session"`, and anything else denies.
 */
export const approvalDecisionOf = (
  item: RunAgentResumeItem,
): ApprovalDecision => {
  if (item.status === "cancelled") {
    return "deny";
  }
  const payload: unknown = item.payload;
  if (typeof payload === "boolean") {
    return payload ? "approve" : "deny";
  }
  if (isRecord(payload) && payload["approved"] === true) {
    return payload["scope"] === "session" ? "approve_for_session" : "approve";
  }
  return "deny";
};

/**
 * Call ids the harness mints are unique only within its own run, so every id
 * of a local run is prefixed with the run: stable across the turn's pause and
 * resume, and unique across the thread.
 */
const MAX_CALL_ID_LENGTH = 256;

const localCallId = (runnerRunId: string, toolCallId: string) => {
  const prefixed = `${runnerRunId.replaceAll("-", "")}_${toolCallId}`;
  // A harness id too long for the budget keeps its identity as a digest, so
  // two long ids never collapse into one call.
  return prefixed.length <= MAX_CALL_ID_LENGTH
    ? prefixed
    : `${runnerRunId.replaceAll("-", "")}_${sha256Hex(toolCallId)}`;
};

type RewriteContext = {
  runnerRunId: string;
  chatRunId: string;
  threadId: string;
};

/**
 * Which stored events a local turn carries. A harness turn is text, reasoning,
 * tool calls and their results, and its run's start, end and custom events,
 * as `harnessEventsToChunks` maps them. Every other event is dropped: a
 * snapshot or a chunked tool call would write message state or call ownership
 * past the stamping below, and nothing a harness reports needs one.
 */
const LOCAL_RUN_EVENT_DISPOSITION = {
  [EventType.TEXT_MESSAGE_START]: "carry",
  [EventType.TEXT_MESSAGE_CONTENT]: "carry",
  [EventType.TEXT_MESSAGE_END]: "carry",
  [EventType.TEXT_MESSAGE_CHUNK]: "drop",
  [EventType.TOOL_CALL_START]: "carry",
  [EventType.TOOL_CALL_ARGS]: "carry",
  [EventType.TOOL_CALL_END]: "carry",
  [EventType.TOOL_CALL_CHUNK]: "drop",
  [EventType.TOOL_CALL_RESULT]: "carry",
  [EventType.STATE_SNAPSHOT]: "drop",
  [EventType.STATE_DELTA]: "drop",
  [EventType.MESSAGES_SNAPSHOT]: "drop",
  [EventType.ACTIVITY_SNAPSHOT]: "drop",
  [EventType.ACTIVITY_DELTA]: "drop",
  [EventType.RAW]: "drop",
  [EventType.CUSTOM]: "carry",
  [EventType.RUN_STARTED]: "carry",
  [EventType.RUN_FINISHED]: "carry",
  [EventType.RUN_ERROR]: "carry",
  [EventType.STEP_STARTED]: "drop",
  [EventType.STEP_FINISHED]: "drop",
  [EventType.REASONING_START]: "carry",
  [EventType.REASONING_MESSAGE_START]: "carry",
  [EventType.REASONING_MESSAGE_CONTENT]: "carry",
  [EventType.REASONING_MESSAGE_END]: "carry",
  [EventType.REASONING_MESSAGE_CHUNK]: "drop",
  [EventType.REASONING_END]: "carry",
  [EventType.REASONING_ENCRYPTED_VALUE]: "drop",
  [EventType.SUBAGENT_STARTED]: "drop",
  [EventType.SUBAGENT_FINISHED]: "drop",
  [EventType.SUBAGENT_ERROR]: "drop",
} as const satisfies Record<EventType, "carry" | "drop">;

/**
 * The named events a harness turn reports (`harnessEventsToChunks`). The name
 * decides what a stream processor does with a CUSTOM event, and some write to
 * the message (`ui-resource`, `approval-requested`, `structured-output.*`), so
 * only these pass; the rest of what a desktop sends goes no further.
 */
const LOCAL_RUN_CUSTOM_EVENTS: ReadonlySet<string> = new Set([
  ...AGENT_HARNESSES.map((harness) => `${harness}.session-id`),
  HARNESS_CONTINUATION_EVENT,
]);

/** The chunks a stream processor merges metadata from into the message. */
const MESSAGE_METADATA_EVENTS: ReadonlySet<string> = new Set([
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
]);

/**
 * A finished run's context report as the chat reads it: under its one key
 * only when it is a valid report. A desktop is not trusted, so anything else
 * under the key is dropped.
 */
const withCheckedContext = (
  chunk: Extract<PublicStreamChunk, { type: EventType.RUN_FINISHED }>,
) => {
  if (chunk.metadata?.[CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY] !== undefined) {
    const { [CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY]: reported, ...metadata } =
      chunk.metadata;
    const parsed = v.safeParse(chatLocalRunContextSchema, reported);
    return {
      ...chunk,
      metadata: parsed.success
        ? { ...metadata, [CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY]: parsed.output }
        : metadata,
    };
  }
  return chunk;
};

/**
 * The chunk as this chat run carries it: its run, thread and call ids, and
 * every call owned by the harness that ran it, whatever the desktop said, so
 * no call of a local turn ever reads as one the API or the browser runs.
 * `null` for an event a local turn does not carry.
 */
const asChatChunk = (
  chunk: PublicStreamChunk,
  { runnerRunId, chatRunId, threadId }: RewriteContext,
): PublicStreamChunk | null => {
  if (LOCAL_RUN_EVENT_DISPOSITION[chunk.type] === "drop") {
    return null;
  }
  const callId = (id: string) => localCallId(runnerRunId, id);
  if (chunk.type === EventType.TOOL_CALL_START) {
    return {
      ...chunk,
      toolCallId: callId(chunk.toolCallId),
      metadata: {
        ...chunk.metadata,
        [CHAT_TOOL_EXECUTOR_METADATA_KEY]: CHAT_TOOL_EXECUTOR.harness,
      },
    };
  }
  // Only these name a run, a thread or a call; every other chunk passes as is.
  if (chunk.type === EventType.RUN_STARTED) {
    return { ...chunk, runId: chatRunId, threadId };
  }
  if (chunk.type === EventType.RUN_FINISHED) {
    return {
      ...withCheckedContext(chunk),
      runId: chatRunId,
      threadId,
      ...(chunk.outcome?.type === "interrupt"
        ? {
            outcome: {
              ...chunk.outcome,
              interrupts: chunk.outcome.interrupts.map((interrupt) =>
                interrupt.toolCallId === undefined
                  ? interrupt
                  : {
                      ...interrupt,
                      toolCallId: callId(interrupt.toolCallId),
                    },
              ),
            },
          }
        : {}),
    };
  }
  if (
    chunk.type === EventType.TOOL_CALL_ARGS ||
    chunk.type === EventType.TOOL_CALL_END ||
    chunk.type === EventType.TOOL_CALL_RESULT
  ) {
    return { ...chunk, toolCallId: callId(chunk.toolCallId) };
  }
  if (chunk.type === EventType.CUSTOM) {
    return LOCAL_RUN_CUSTOM_EVENTS.has(chunk.name) ? chunk : null;
  }
  // Metadata on these merges into the answer, where the server's own notices
  // and files live. A harness reports only its adapter's own `tanstack` block,
  // so nothing else a desktop sends is carried.
  if (MESSAGE_METADATA_EVENTS.has(chunk.type) && "metadata" in chunk) {
    const { metadata, ...carried } = chunk;
    const kept = Object.entries(isRecord(metadata) ? metadata : {}).filter(
      ([key]) => key === "tanstack",
    );
    return kept.length === 0
      ? carried
      : { ...carried, metadata: Object.fromEntries(kept) };
  }
  return chunk;
};

/** A chunk this source makes itself, in the public form the pipeline reads. */
const publicChunks = (chunk: AdapterYieldChunk): PublicStreamChunk[] =>
  normalizeStreamChunk(chunk);

type LocalRunFailureDetails = {
  code: string;
  message: string;
  /** When the harness's usage limit resets; only on a limit failure. */
  limit?: ChatLocalRunLimit | undefined;
};

/** The run error that ends the turn; `code` names why for the member. */
const runErrorChunks = (
  { code, message, limit }: LocalRunFailureDetails,
  { chatRunId, threadId }: Pick<RewriteContext, "chatRunId" | "threadId">,
): PublicStreamChunk[] =>
  publicChunks({
    type: EventType.RUN_ERROR,
    runId: chatRunId,
    threadId,
    message,
    code,
    error: { message, code },
    ...(limit === undefined
      ? {}
      : { metadata: { [CHAT_LOCAL_RUN_LIMIT_METADATA_KEY]: limit } }),
    timestamp: nowMs(),
  });

const failureOf = (code: LocalRunFailure, message?: string) => ({
  code,
  message: message ?? FAILURE_MESSAGE[code],
});

/**
 * When the limit a harness's run error names resets. The desktop is not
 * trusted: anything but a valid instant under the one key carries no time.
 */
const limitOfRunError = (
  chunk: Extract<PublicStreamChunk, { type: EventType.RUN_ERROR }>,
): ChatLocalRunLimit | undefined => {
  const parsed = v.safeParse(
    chatLocalRunLimitSchema,
    chunk.metadata?.[CHAT_LOCAL_RUN_LIMIT_METADATA_KEY],
  );
  return parsed.success ? parsed.output : undefined;
};

/** The finish that ends the turn without an error. */
const runFinishedChunks = (
  { chatRunId, threadId }: Pick<RewriteContext, "chatRunId" | "threadId">,
  stopped: boolean,
): PublicStreamChunk[] =>
  publicChunks({
    type: EventType.RUN_FINISHED,
    runId: chatRunId,
    threadId,
    finishReason: "stop",
    ...(stopped ? { outcome: { type: "cancelled" as const } } : {}),
    timestamp: nowMs(),
  });

type HarnessError = {
  code: string;
  message: string;
  limit: ChatLocalRunLimit | undefined;
};

/**
 * Why a failed run ended the turn: the outcome's own failure, else the
 * harness's error. Only a limit failure says when the limit resets.
 */
const failedRunDetails = (
  code: LocalRunFailure | null,
  harnessError: HarnessError | null,
): LocalRunFailureDetails => {
  if (code !== null) {
    return {
      ...failureOf(code, harnessError?.message),
      ...(code === AI_FAILURE_CODES.local_runner_limit_reached
        ? { limit: harnessError?.limit }
        : {}),
    };
  }
  return harnessError === null
    ? failureOf(AI_FAILURE_CODES.local_runner_unavailable)
    : { code: harnessError.code, message: harnessError.message };
};

/** The chunks that end the turn once the run said how it finished. */
const finishedRunChunks = ({
  outcome,
  finishSent,
  harnessError,
  rewrite,
}: {
  outcome: StoredOutcome;
  /** Whether the harness's own finish already went out. */
  finishSent: boolean;
  harnessError: HarnessError | null;
  rewrite: Pick<RewriteContext, "chatRunId" | "threadId">;
}): PublicStreamChunk[] => {
  const ending = LOCAL_RUN_OUTCOME[outcome];
  switch (ending.type) {
    case "completed":
    case "stopped":
      return finishSent
        ? []
        : runFinishedChunks(rewrite, ending.type === "stopped");
    case "failed":
      return runErrorChunks(
        failedRunDetails(ending.code, harnessError),
        rewrite,
      );
    default:
      ending satisfies never;
      return panic("Unknown local run outcome");
  }
};

/** Telling a turn's agent where the member's files go, on local runs only. */
export const LOCAL_RUN_OUTPUTS_INSTRUCTIONS = `Files meant for the member go in the outputs/ folder of your working folder, as ${RUN_OUTPUT_FILE_EXTENSIONS.join(", ")}: when your turn ends, the chat shows what you wrote there. Everything else in the working folder, scratch files and caches included, stays on this computer.`;

/**
 * What an open read does once it has caught up: wait for more (with the
 * computer there or away), read the final message the run stored with its
 * transition, or end the turn with why the gateway gave the run up.
 */
const caughtUpStep = (
  run: DesktopRunnerRunView | null,
):
  | { type: "wait"; computer: ChatLocalRunComputerEvent["status"] }
  | { type: "read" }
  | { type: "fail"; code: LocalRunFailure } => {
  if (run === null) {
    return { type: "fail", code: AI_FAILURE_CODES.local_runner_unavailable };
  }
  switch (run.state) {
    case "rejected":
      return {
        type: "fail",
        code:
          run.rejectReason === null
            ? AI_FAILURE_CODES.local_runner_unavailable
            : LOCAL_RUN_REJECTION[run.rejectReason],
      };
    case "lost":
      return { type: "fail", code: AI_FAILURE_CODES.local_runner_unavailable };
    case "finished":
      return { type: "read" };
    case "assigned":
    case "running":
      return { type: "wait", computer: "connected" };
    case "waiting_for_computer":
      // A computer that is away resumes the run when it reconnects.
      return { type: "wait", computer: "waiting" };
    default:
      run.state satisfies never;
      return panic("Unknown desktop runner run state");
  }
};

/**
 * A run store that cannot be read ends the turn as a computer that stopped
 * running it: the member retries, and nothing the run produced is lost.
 */
const LOCAL_RUN_STORE_SINK = failureSink({
  event: "chat.local_run_store_failed",
  expected: [],
});

const storeUnavailable = (
  error: DatabaseError,
  rewrite: Pick<RewriteContext, "chatRunId" | "threadId">,
): PublicStreamChunk[] => {
  observeFailure(error, { sink: LOCAL_RUN_STORE_SINK });
  return runErrorChunks(
    failureOf(AI_FAILURE_CODES.local_runner_unavailable),
    rewrite,
  );
};

class LocalRunOutputRefused extends TaggedError("LocalRunOutputRefused")<{
  message: string;
}> {}

const LOCAL_RUN_OUTPUT_REFUSED_SINK = failureSink({
  event: "chat.local_run_output_refused",
  expected: [],
});

/** What a stored chunk reports about one output file, if that is what it is. */
const runOutputReportOf = (
  chunk: PublicStreamChunk,
): { value: unknown } | null =>
  chunk.type === EventType.CUSTOM && chunk.name === DESKTOP_RUNNER_OUTPUT_EVENT
    ? { value: chunk.value }
    : null;

/**
 * How many files one answer names. A computer's sidecar holds itself to less;
 * this bounds what any desktop can make the stored answer carry.
 */
const MAX_ANSWER_RUN_FILES = 50;

/**
 * What one read of a run has told the chat about the files it handed back. Each
 * report restates all of it: a stream processor merges metadata key by key.
 */
const createRunOutputs = (
  context: LocalRunContext,
  rewrite: RewriteContext,
) => {
  const files: ChatLocalRunFile[] = [];
  const notShared: string[] = [];
  /** The answer's own id, so the chunk opens it when nothing else has yet. */
  const messageId = rewrite.runnerRunId;
  const read = async (fileId: SafeId<"userFile">) => {
    const row = await context.control.readRunOutputFile({
      owner: context.owner,
      chatThreadId: context.chatThreadId,
      fileId,
    });
    if (row.isErr()) {
      observeFailure(row.error, { sink: LOCAL_RUN_STORE_SINK });
      return "unavailable" as const;
    }
    return row.value;
  };
  return async (value: unknown): Promise<PublicStreamChunk[]> => {
    const report = v.safeParse(desktopRunnerOutputEventSchema, value);
    if (
      !report.success ||
      files.length + notShared.length >= MAX_ANSWER_RUN_FILES
    ) {
      return [];
    }
    if (report.output.status === "failed") {
      notShared.push(sanitizeFilename(report.output.fileName));
    } else {
      const row = await read(brandPersistedUserFileId(report.output.fileId));
      if (row === "unavailable") {
        notShared.push(sanitizeFilename(report.output.fileName));
      } else if (row === null) {
        // Not this member's file in this thread: a report like this names
        // nothing the chat may show, and tells the member nothing true.
        observeFailure(
          new LocalRunOutputRefused({
            message: "A computer reported a file its run may not show",
          }),
          { sink: LOCAL_RUN_OUTPUT_REFUSED_SINK },
        );
        return [];
      } else {
        const url = toUserFileUrl(row.id);
        if (!files.some((file) => file.url === url)) {
          files.push({
            url,
            filename: row.fileName,
            mimeType: row.mimeType,
            ...(row.placeholder === null
              ? {}
              : { placeholder: row.placeholder }),
          });
        }
      }
    }
    return [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        timestamp: nowMs(),
        metadata: {
          ...(files.length === 0
            ? {}
            : { [CHAT_LOCAL_RUN_FILES_METADATA_KEY]: [...files] }),
          ...(notShared.length === 0
            ? {}
            : {
                [CHAT_LOCAL_RUN_FILES_NOT_SHARED_METADATA_KEY]: [...notShared],
              }),
        },
      },
    ];
  };
};

type ReadRunOptions = {
  context: LocalRunContext;
  runnerRunId: string;
  afterSeq: number;
  chatRunId: string;
  abortSignal: AbortSignal;
};

/**
 * Stop the computer's turn: what a user's stop, a deadline or a lost owner
 * means for a run nobody reads any more. The gateway keeps one interrupt per
 * run, so a repeat is a no-op.
 */
const interruptRun = async (context: LocalRunContext, runnerRunId: string) => {
  const stopped = await context.control.interruptRun({
    owner: context.owner,
    runId: runnerRunId,
  });
  // The turn ends either way; a stop that could not be queued is observed,
  // and the gateway ends a run nobody reads once it is abandoned.
  if (stopped.isErr()) {
    observeFailure(stopped.error, { sink: LOCAL_RUN_STORE_SINK });
  }
};

/**
 * Tells the chat when its computer went away or came back. Only a change is
 * sent, so a long wait adds one event to the run log, not one per poll; the
 * run's start goes first when none went out yet.
 */
const computerStatusChunks = (start: () => Generator<PublicStreamChunk>) => {
  /** Whether the turn last told the chat its computer is away. */
  let away = false;
  return function* (
    status: ChatLocalRunComputerEvent["status"],
  ): Generator<PublicStreamChunk> {
    const nowAway = status === "waiting";
    if (nowAway === away) {
      return;
    }
    away = nowAway;
    yield* start();
    yield {
      type: EventType.CUSTOM,
      name: CHAT_LOCAL_RUN_COMPUTER_EVENT,
      value: { status } satisfies ChatLocalRunComputerEvent,
      timestamp: nowMs(),
    };
  };
};

/**
 * The run's chunks after `afterSeq`, until the run finishes or pauses for an
 * approval or a blocking question. A pause records the position, so the
 * resumed turn continues after it. A computer that is away keeps the turn waiting; a run the gateway
 * gave up on ends it with a failure the member can read.
 *
 * @yields Chunks of the chat run, ending with its terminal one.
 */
async function* readRunChunks({
  context,
  runnerRunId,
  afterSeq,
  chatRunId,
  abortSignal,
}: ReadRunOptions): AsyncGenerator<PublicStreamChunk> {
  const { control, owner } = context;
  const rewrite: RewriteContext = {
    runnerRunId,
    chatRunId,
    threadId: context.chatThreadId,
  };
  let position = afterSeq;
  let started = false;
  let finished = false;
  /** The harness's own run error, held for the outcome `run.finished` names. */
  let harnessError: HarnessError | null = null;
  const start = function* (): Generator<PublicStreamChunk> {
    if (!started) {
      started = true;
      yield {
        type: EventType.RUN_STARTED,
        runId: chatRunId,
        threadId: context.chatThreadId,
        timestamp: nowMs(),
      };
    }
  };
  const computer = computerStatusChunks(start);
  const runOutputChunks = createRunOutputs(context, rewrite);
  const fail = function* (
    code: LocalRunFailure,
    message?: string,
  ): Generator<PublicStreamChunk> {
    yield* start();
    yield* runErrorChunks(failureOf(code, message), rewrite);
  };
  /** Record the read position; the resumed turn continues after it. */
  const pause = async () =>
    await control.recordChatReadSeq({
      owner,
      runId: runnerRunId,
      seq: position,
    });
  /**
   * The run is this reader's to end until it finishes or pauses for an
   * answer. Any other way the read ends interrupts it, once: a cut of the
   * turn while the read waits or while its consumer is not pulling, a
   * consumer that stops reading, a store that cannot be read.
   */
  let holdsRun = true;
  let interrupting: Promise<void> | null = null;
  const stopRun = async () => {
    if (holdsRun) {
      holdsRun = false;
      interrupting = interruptRun(context, runnerRunId);
    }
    await interrupting;
  };
  /** The run finished, ended on the gateway's side, or paused. */
  const releaseRun = () => {
    holdsRun = false;
  };
  const onCut = () => {
    detached(stopRun, "local-run-chunks.interrupt");
  };
  abortSignal.addEventListener("abort", onCut, { once: true });
  const listener = context.runBell.listen(runnerRunId);
  try {
    for (;;) {
      if (abortSignal.aborted) {
        await stopRun();
        return;
      }
      const page = await control.readEvents({
        owner,
        runId: runnerRunId,
        afterSeq: position,
        limit: EVENT_PAGE,
      });
      if (page.isErr()) {
        // Nobody reads this turn any more; stop the computer before reporting.
        await stopRun();
        yield* start();
        yield* storeUnavailable(page.error, rewrite);
        return;
      }
      if (page.value.items.length > 0) {
        // Anything the computer stored since it was away means it is back.
        yield* computer("connected");
      }
      for (const item of page.value.items) {
        position = item.seq;
        const parsed = v.safeParse(
          desktopRunnerDesktopMessageSchema,
          item.message,
        );
        if (!parsed.success) {
          panic("A stored desktop runner message no longer validates");
        }
        const message = parsed.output;
        switch (message.type) {
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent: {
            if (!isPublicStreamChunk(message.chunk)) {
              panic("A stored desktop runner chunk no longer folds");
            }
            const output = runOutputReportOf(message.chunk);
            if (output !== null) {
              yield* start();
              yield* await runOutputChunks(output.value);
              continue;
            }
            const chunk = asChatChunk(message.chunk, rewrite);
            if (chunk === null) {
              continue;
            }
            if (chunk.type === EventType.RUN_STARTED) {
              // A run resumed after a pause opens a new segment; the chat
              // run is one.
              yield* start();
              continue;
            }
            if (chunk.type === EventType.RUN_ERROR) {
              harnessError = {
                code: chunk.code ?? AI_FAILURE_CODES.local_runner_unavailable,
                message: chunk.message,
                limit: limitOfRunError(chunk),
              };
              continue;
            }
            yield* start();
            if (chunk.type !== EventType.RUN_FINISHED) {
              yield chunk;
              continue;
            }
            if (chunk.outcome?.type === "interrupt") {
              // The position is stored before the pause is handed out, so an
              // answer always continues after it.
              const recorded = await pause();
              if (recorded.isErr()) {
                await stopRun();
                yield* storeUnavailable(recorded.error, rewrite);
                return;
              }
              // The paused run is the turn's now: it waits for the answer
              // while the turn awaits it, and is cancelled once the turn ends
              // any other way (`readRunsOfEndedChatTurns`).
              releaseRun();
              yield chunk;
              return;
            }
            // The harness finished its turn: nothing is left to interrupt,
            // only the run's own end to read.
            releaseRun();
            yield chunk;
            finished = true;
            continue;
          }
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest:
            // The chunk stream carries the interrupt the member answers.
            continue;
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished: {
            releaseRun();
            const ending = finishedRunChunks({
              outcome: message.outcome,
              finishSent: finished,
              harnessError,
              rewrite,
            });
            if (ending.length > 0) {
              yield* start();
              yield* ending;
            }
            return;
          }
          // The gateway stores only sequenced messages for a run.
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.hello:
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.harnessStatus:
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runAccepted:
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runRejected:
            panic(`A run stored an unsequenced ${message.type}`);
        }
      }
      if (page.value.nextAfterSeq !== null) {
        continue;
      }
      const run = await control.readRun({ owner, runId: runnerRunId });
      if (run.isErr()) {
        await stopRun();
        yield* start();
        yield* storeUnavailable(run.error, rewrite);
        return;
      }
      const step = caughtUpStep(run.value);
      switch (step.type) {
        case "fail":
          // The gateway already ended the run: rejected, lost, or gone.
          releaseRun();
          yield* fail(step.code);
          return;
        case "read":
          continue;
        case "wait":
          yield* computer(step.computer);
          await listener.wait({
            timeoutMs: context.pollMs ?? DEFAULT_POLL_MS,
            signal: abortSignal,
          });
          continue;
        default:
          step satisfies never;
          panic("Unknown caught-up step");
      }
    }
  } finally {
    abortSignal.removeEventListener("abort", onCut);
    listener.close();
    // A consumer that closed the read early, or a read that threw.
    await stopRun();
  }
}

/** Why a harness the computer reported cannot take the turn, for the member. */
const unavailableHarnessFailure = (
  state: DesktopRunnerHarnessReport["state"] | undefined,
): LocalRunFailure => {
  switch (state) {
    case "needs_login":
      return AI_FAILURE_CODES.local_runner_needs_login;
    case "limit_until":
      return AI_FAILURE_CODES.local_runner_limit_reached;
    case "ready":
    case "not_installed":
    case "unsupported":
    case "unavailable":
    case undefined:
      return AI_FAILURE_CODES.local_runner_unavailable;
    default:
      state satisfies never;
      return panic("Unknown harness state");
  }
};

type StartOptions = {
  attachments: readonly LocalRunAttachment[];
  context: LocalRunContext;
  destination: LocalRunDestination;
  input: LocalRunStreamInput;
};

/**
 * Start the turn's run on the routed computer; a refusal ends the turn.
 *
 * @yields Chunks of the chat run, ending with its terminal one.
 */
async function* startLocalRun({
  attachments,
  context,
  destination,
  input,
}: StartOptions): AsyncGenerator<PublicStreamChunk> {
  const { control, owner } = context;
  const session = await control.readChatRunSession({
    owner,
    chat: { threadId: context.chatThreadId, turnId: input.chatTurnId },
    desktopId: destination.desktopId,
    harness: destination.harness,
  });
  const rewrite = {
    chatRunId: input.chatRunId,
    threadId: context.chatThreadId,
  };
  const opened = {
    type: EventType.RUN_STARTED,
    runId: input.chatRunId,
    threadId: context.chatThreadId,
    timestamp: nowMs(),
  } as const satisfies PublicStreamChunk;
  if (session.isErr()) {
    yield opened;
    yield* storeUnavailable(session.error, rewrite);
    return;
  }
  const harnessSessionId = session.value;
  const start = async (messages: readonly ModelMessage[]) =>
    await control.startRun({
      owner,
      desktopId: destination.desktopId,
      harness: destination.harness,
      harnessVersion: destination.harnessVersion,
      model: destination.model,
      approvals: destination.approvals,
      harnessSessionId,
      instructions: input.instructions,
      // Copied to plain objects: the wire schema reads them as records.
      messages: messages.map((message) => ({ ...message })),
      attachments,
      mcp: context.mcp,
      workspaceIds: context.workspaceIds,
      chat: { threadId: context.chatThreadId, turnId: input.chatTurnId },
    });
  let started = await start(input.messages);
  const latest = input.messages.at(-1);
  if (
    started.isOk() &&
    started.value.type === "too_large" &&
    harnessSessionId !== null &&
    latest !== undefined
  ) {
    // The resumed session already holds the history.
    started = await start([latest]);
  }
  const refuse = function* (code: LocalRunFailure) {
    yield opened;
    yield* runErrorChunks(failureOf(code), rewrite);
  };
  if (started.isErr()) {
    if (started.error._tag === "DatabaseError") {
      yield opened;
      yield* storeUnavailable(started.error, rewrite);
      return;
    }
    // A command the wire contract refuses: the prompt or history is out of
    // what one run may carry.
    yield* refuse(AI_FAILURE_CODES.local_runner_unavailable);
    return;
  }
  const outcome = started.value;
  switch (outcome.type) {
    case "assigned":
      yield* readRunChunks({
        context,
        runnerRunId: outcome.runId,
        afterSeq: 0,
        chatRunId: input.chatRunId,
        abortSignal: input.abortSignal,
      });
      return;
    case "harness_unavailable":
      yield* refuse(unavailableHarnessFailure(outcome.report?.state));
      return;
    case "no_computer":
    case "model_unavailable":
    case "approvals_unavailable":
      yield* refuse(AI_FAILURE_CODES.local_runner_unavailable);
      return;
    case "too_large":
      yield* refuse(AI_FAILURE_CODES.local_runner_turn_too_large);
      return;
    default:
      outcome satisfies never;
      panic("Unknown local run start outcome");
  }
}

/** Whether a queued command lets the paused run go on; `null` once it is queued. */
const queuedCommandFailure = (
  outcome: QueueCommandOutcome,
): LocalRunFailure | null => {
  switch (outcome.type) {
    case "queued":
    case "duplicate":
      return null;
    case "run_ended":
    case "run_not_found":
    case "not_requested":
    case "command_limit":
    case "too_large":
      return AI_FAILURE_CODES.local_runner_unavailable;
    default:
      outcome satisfies never;
      return panic("Unknown desktop runner command outcome");
  }
};

/**
 * An answer to a blocking question that does not answer it
 * (`questionReplyOf`). The reason names question ids only, never what was
 * answered.
 */
class LocalRunAnswerRefused extends TaggedError("LocalRunAnswerRefused")<{
  message: string;
}> {}

const LOCAL_RUN_ANSWER_SINK = failureSink({
  event: "chat.local_run_answer_refused",
  expected: [],
});

/** What the paused run receives for the member's answer. */
type ResumeCommand =
  | { type: "queued"; outcome: QueueCommandOutcome }
  | { type: "refused"; reason: string };

/**
 * Hand the member's answer to the run that paused for it: an approval as its
 * decision, a question as its answers, or, when the member dismissed the
 * question, a stop of the run's turn.
 */
const answerPausedRun = async (
  context: LocalRunContext,
  item: RunAgentResumeItem & { interruptId: string },
  run: ChatRunForRequest,
): Promise<Result<ResumeCommand, DesktopRunnerControlError>> => {
  const { control, owner } = context;
  const queued = (
    outcome: Result<QueueCommandOutcome, DesktopRunnerControlError>,
  ) =>
    outcome.map((value): ResumeCommand => ({ type: "queued", outcome: value }));
  switch (run.askedBy) {
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest:
      return queued(
        await control.answerApproval({
          owner,
          runId: run.runId,
          requestId: item.interruptId,
          decision: approvalDecisionOf(item),
        }),
      );
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent: {
      if (item.status === "cancelled") {
        // The harness ends the turn it paused; the reader reads that end.
        return queued(await control.interruptRun({ owner, runId: run.runId }));
      }
      const stored = v.safeParse(
        desktopRunnerDesktopMessageSchema,
        run.request,
      );
      const pause = stored.success
        ? questionPauseOf(
            stored.output.type === DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent
              ? stored.output.chunk
              : null,
          )
        : null;
      if (pause?.type !== "question" || pause.requestId !== item.interruptId) {
        return panic("A stored question pause no longer reads as one");
      }
      const answered = questionReplyOf(item.payload, pause.questions);
      if (answered.type === "refused") {
        return Result.ok({ type: "refused", reason: answered.reason });
      }
      return queued(
        await control.answerQuestion({
          owner,
          runId: run.runId,
          requestId: item.interruptId,
          answers: answered.answers,
        }),
      );
    }
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished:
      return panic("A run's final message asked nothing");
    default:
      run.askedBy satisfies never;
      return panic("Unknown desktop runner request");
  }
};

type ResumeOptions = {
  context: LocalRunContext;
  input: LocalRunStreamInput & { resume: readonly RunAgentResumeItem[] };
};

/**
 * Answer the approval or blocking question the run paused for on the same
 * run, then continue reading it after where the paused turn stopped.
 *
 * @yields Chunks of the chat run, ending with its terminal one.
 */
async function* resumeLocalRun({
  context,
  input,
}: ResumeOptions): AsyncGenerator<PublicStreamChunk> {
  const { control, owner } = context;
  const uuid = v.pipe(v.string(), v.uuid());
  const rewrite = {
    chatRunId: input.chatRunId,
    threadId: context.chatThreadId,
  };
  const opened = {
    type: EventType.RUN_STARTED,
    runId: input.chatRunId,
    threadId: context.chatThreadId,
    timestamp: nowMs(),
  } as const satisfies PublicStreamChunk;
  const fail = function* (code: LocalRunFailure, message?: string) {
    yield opened;
    yield* runErrorChunks(failureOf(code, message), rewrite);
  };
  // The harness pauses for one request at a time, so a resume answers one.
  const [item, ...rest] = input.resume;
  // Request ids are minted as UUIDs by the runner protocol.
  if (item === undefined || rest.length > 0 || !v.is(uuid, item.interruptId)) {
    yield* fail(AI_FAILURE_CODES.local_runner_unavailable);
    return;
  }
  const found = await control.readChatRunForRequest({
    owner,
    chat: { threadId: context.chatThreadId, turnId: input.chatTurnId },
    requestId: item.interruptId,
  });
  if (found.isErr()) {
    yield opened;
    yield* storeUnavailable(found.error, rewrite);
    return;
  }
  const run = found.value;
  if (run === null) {
    yield* fail(AI_FAILURE_CODES.local_runner_unavailable);
    return;
  }
  const answered = await answerPausedRun(
    context,
    { ...item, interruptId: item.interruptId },
    run,
  );
  if (answered.isErr()) {
    if (answered.error._tag === "DatabaseError") {
      yield opened;
      yield* storeUnavailable(answered.error, rewrite);
      return;
    }
    yield* fail(AI_FAILURE_CODES.local_runner_unavailable);
    return;
  }
  const command = answered.value;
  switch (command.type) {
    case "refused": {
      observeFailure(new LocalRunAnswerRefused({ message: command.reason }), {
        sink: LOCAL_RUN_ANSWER_SINK,
      });
      // The turn that owned the question ends here, so the run stops waiting
      // for an answer nobody can give any more.
      await interruptRun(context, run.runId);
      yield* fail(AI_FAILURE_CODES.local_runner_unavailable, command.reason);
      return;
    }
    case "queued": {
      const failure = queuedCommandFailure(command.outcome);
      if (failure !== null) {
        yield* fail(failure);
        return;
      }
      break;
    }
    default:
      command satisfies never;
      panic("Unknown resume command");
  }
  yield* readRunChunks({
    context,
    runnerRunId: run.runId,
    afterSeq: run.chatReadSeq,
    chatRunId: input.chatRunId,
    abortSignal: input.abortSignal,
  });
}

/**
 * How a turn reaches its run: a new turn starts one on the computer it was
 * routed to, a resumed turn answers the run that paused, wherever it is.
 */
export type LocalRunPlan =
  | { type: "start"; destination: LocalRunDestination }
  | { type: "resume"; harness: ChatLocalRunHarness };

/** A local chat run for one turn. */
const localChatRun = (
  context: LocalRunContext,
  plan: LocalRunPlan,
  attachments: readonly LocalRunAttachment[],
): LocalChatRun => ({
  harness: plan.type === "start" ? plan.destination.harness : plan.harness,
  withAttachments: (next) => localChatRun(context, plan, next),
  stream: (input) => {
    const { resume } = input;
    switch (plan.type) {
      case "start":
        return resume === undefined || resume.length === 0
          ? startLocalRun({
              attachments,
              context,
              destination: plan.destination,
              input,
            })
          : panic("A new local turn was handed approvals to resume");
      case "resume":
        return resume !== undefined && resume.length > 0
          ? resumeLocalRun({ context, input: { ...input, resume } })
          : panic("A resumed local turn carries no approvals");
      default:
        plan satisfies never;
        return panic("Unknown local run plan");
    }
  },
});

export const createLocalChatRun = (
  context: LocalRunContext,
  plan: LocalRunPlan,
): LocalChatRun => localChatRun(context, plan, []);
