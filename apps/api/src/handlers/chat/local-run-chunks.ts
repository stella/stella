import { EventSchema } from "@ag-ui/core/schemas";
import {
  type AdapterYieldChunk,
  EventType,
  type ModelMessage,
  normalizeStreamChunk,
  type RunAgentResumeItem,
} from "@tanstack/ai";
import { panic } from "better-result";
import * as v from "valibot";

import { AI_FAILURE_CODES } from "@stll/api-contract";
import type { ChatLocalRunHarness } from "@stll/api-contract/chat-run-target";
import {
  type DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  type DesktopRunnerDesktopMessage,
  desktopRunnerDesktopMessageSchema,
  type DesktopRunnerHarnessReport,
} from "@stll/api-contract/desktop-runner";
import { Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { DesktopRunnerRunBell } from "@/api/lib/desktop-runner/doorbell";
import type {
  DesktopRunnerRunView,
  RunOwner,
} from "@/api/lib/desktop-runner/store";
import { isRecord } from "@/api/lib/type-guards";

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
export type LocalRunControl = Pick<
  DesktopRunnerControl,
  | "answerApproval"
  | "interruptRun"
  | "readChatRunForRequest"
  | "readChatRunSession"
  | "readEvents"
  | "readRun"
  | "recordChatReadSeq"
  | "startRun"
>;

/** The computer and harness a new turn was routed to before it started. */
export type LocalRunDestination = {
  desktopId: string;
  harness: ChatLocalRunHarness;
  harnessVersion: string;
  model: string;
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

export type LocalRunStreamInput = {
  /** The chat run this attempt answers; every run event carries it. */
  chatRunId: string;
  /** The thread history, as the cloud model would receive it. */
  messages: readonly ModelMessage[];
  /** The system prompt the cloud model would receive. */
  instructions: string;
  /** Answers to the approvals the run paused for; absent on a new turn. */
  resume: readonly RunAgentResumeItem[] | undefined;
  abortSignal: AbortSignal;
};

/** A chat turn bound to a computer: started on a new turn, continued on a resume. */
export type LocalChatRun = {
  readonly harness: ChatLocalRunHarness;
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
  | typeof AI_FAILURE_CODES.local_runner_unavailable;

const FAILURE_MESSAGE = {
  [AI_FAILURE_CODES.local_runner_needs_login]:
    "The harness on the computer needs a sign-in.",
  [AI_FAILURE_CODES.local_runner_limit_reached]:
    "The harness on the computer reached its usage limit.",
  [AI_FAILURE_CODES.local_runner_unavailable]:
    "The computer stopped running the turn.",
} as const satisfies Record<LocalRunFailure, string>;

type StoredOutcome = Extract<
  DesktopRunnerDesktopMessage,
  { type: typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished }
>["outcome"];

/**
 * How a finished run ends the chat turn. A failure the member can act on
 * keeps its own code; an interruption ends the turn as stopped.
 */
export const LOCAL_RUN_OUTCOME = {
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
export const LOCAL_RUN_REJECTION = {
  harness_needs_login: AI_FAILURE_CODES.local_runner_needs_login,
  harness_limited: AI_FAILURE_CODES.local_runner_limit_reached,
  harness_not_installed: AI_FAILURE_CODES.local_runner_unavailable,
  harness_unsupported: AI_FAILURE_CODES.local_runner_unavailable,
  harness_version_unavailable: AI_FAILURE_CODES.local_runner_unavailable,
  model_unavailable: AI_FAILURE_CODES.local_runner_unavailable,
  policy_unsupported: AI_FAILURE_CODES.local_runner_unavailable,
  at_capacity: AI_FAILURE_CODES.local_runner_unavailable,
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
const localCallId = (runnerRunId: string, toolCallId: string) =>
  `${runnerRunId.replaceAll("-", "")}_${toolCallId}`.slice(0, 256);

type RewriteContext = {
  runnerRunId: string;
  chatRunId: string;
  threadId: string;
};

/** The chunk as this chat run carries it: its run, thread and call ids. */
const asChatChunk = (
  chunk: PublicStreamChunk,
  { runnerRunId, chatRunId, threadId }: RewriteContext,
): PublicStreamChunk => {
  const callId = (id: string) => localCallId(runnerRunId, id);
  switch (chunk.type) {
    case EventType.RUN_STARTED:
      return { ...chunk, runId: chatRunId, threadId };
    case EventType.RUN_FINISHED:
      return {
        ...chunk,
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
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_RESULT:
      return { ...chunk, toolCallId: callId(chunk.toolCallId) };
    case EventType.CUSTOM: {
      const value: unknown = chunk.value;
      return isRecord(value) && typeof value["toolCallId"] === "string"
        ? {
            ...chunk,
            value: { ...value, toolCallId: callId(value["toolCallId"]) },
          }
        : chunk;
    }
    default:
      return chunk;
  }
};

type RunFinishedChunk = Extract<
  PublicStreamChunk,
  { type: EventType.RUN_FINISHED }
>;

/** A chunk this source makes itself, in the public form the pipeline reads. */
const publicChunks = (chunk: AdapterYieldChunk): PublicStreamChunk[] =>
  normalizeStreamChunk(chunk);

/** The interrupt of a blocking harness question, which chat cannot answer in place. */
const questionInterruptOf = (chunk: RunFinishedChunk) =>
  chunk.outcome?.type === "interrupt"
    ? chunk.outcome.interrupts.find(
        (interrupt) =>
          isRecord(interrupt.metadata) &&
          interrupt.metadata["kind"] === "question",
      )
    : undefined;

/** The run error that ends the turn; `code` names why for the member. */
const runErrorChunks = (
  { code, message }: { code: string; message: string },
  { chatRunId, threadId }: Pick<RewriteContext, "chatRunId" | "threadId">,
): PublicStreamChunk[] =>
  publicChunks({
    type: EventType.RUN_ERROR,
    runId: chatRunId,
    threadId,
    message,
    code,
    error: { message, code },
    timestamp: nowMs(),
  });

const failureOf = (code: LocalRunFailure, message?: string) => ({
  code,
  message: message ?? FAILURE_MESSAGE[code],
});

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

type HarnessError = { code: string; message: string };

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
        ending.code === null
          ? (harnessError ??
              failureOf(AI_FAILURE_CODES.local_runner_unavailable))
          : failureOf(ending.code, harnessError?.message),
        rewrite,
      );
    default:
      ending satisfies never;
      return panic("Unknown local run outcome");
  }
};

/**
 * What an open read does once it has caught up: wait for more, read the final
 * message the run stored with its transition, or end the turn with why the
 * gateway gave the run up.
 */
const caughtUpStep = (
  run: DesktopRunnerRunView | null,
):
  | { type: "wait" }
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
    case "waiting_for_computer":
      // A computer that is away resumes the run when it reconnects.
      return { type: "wait" };
    default:
      run.state satisfies never;
      return panic("Unknown desktop runner run state");
  }
};

/**
 * The runner protocol answers approvals only. A blocking question becomes one
 * the member answers with their next message, which resumes the harness
 * session in a new run.
 */
const questionReplyChunks = (
  question: NonNullable<ReturnType<typeof questionInterruptOf>> & {
    toolCallId: string;
  },
  rewrite: Pick<RewriteContext, "chatRunId" | "threadId">,
): PublicStreamChunk[] => [
  {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: question.toolCallId,
    messageId: `${rewrite.chatRunId}:${question.id}`,
    content: JSON.stringify({
      status: "awaiting_reply",
      questions: isRecord(question.metadata)
        ? question.metadata["questions"]
        : [],
    }),
    timestamp: nowMs(),
  },
  ...runFinishedChunks(rewrite, false),
];

type ReadRunOptions = {
  context: LocalRunContext;
  runnerRunId: string;
  afterSeq: number;
  chatRunId: string;
  abortSignal: AbortSignal;
};

/**
 * Stop the computer's turn: what a user's stop, a deadline or a lost owner
 * means for a run nobody reads any more. The run stays open for a later turn.
 */
const interruptRun = async (context: LocalRunContext, runnerRunId: string) => {
  await context.control.interruptRun({
    owner: context.owner,
    runId: runnerRunId,
  });
};

/**
 * The run's chunks after `afterSeq`, until the run finishes or pauses for an
 * approval. A pause records the position, so the resumed turn continues
 * after it. A computer that is away keeps the turn waiting; a run the gateway
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
  const fail = function* (
    code: LocalRunFailure,
    message?: string,
  ): Generator<PublicStreamChunk> {
    yield* start();
    yield* runErrorChunks(failureOf(code, message), rewrite);
  };
  const pause = async () => {
    const recorded = await control.recordChatReadSeq({
      owner,
      runId: runnerRunId,
      seq: position,
    });
    if (recorded.isErr()) {
      throw recorded.error;
    }
  };
  const listener = context.runBell.listen(runnerRunId);
  try {
    for (;;) {
      if (abortSignal.aborted) {
        await interruptRun(context, runnerRunId);
        return;
      }
      const page = await control.readEvents({
        owner,
        runId: runnerRunId,
        afterSeq: position,
        limit: EVENT_PAGE,
      });
      if (page.isErr()) {
        throw page.error;
      }
      for (const item of page.value.items) {
        position = item.seq;
        const parsed = v.safeParse(
          desktopRunnerDesktopMessageSchema,
          item.message,
        );
        if (!parsed.success) {
          return panic("A stored desktop runner message no longer validates");
        }
        const message = parsed.output;
        switch (message.type) {
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent: {
            if (!isPublicStreamChunk(message.chunk)) {
              return panic("A stored desktop runner chunk no longer folds");
            }
            const chunk = asChatChunk(message.chunk, rewrite);
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
              };
              continue;
            }
            yield* start();
            if (chunk.type !== EventType.RUN_FINISHED) {
              yield chunk;
              continue;
            }
            const question = questionInterruptOf(chunk);
            if (question?.toolCallId !== undefined) {
              yield* questionReplyChunks(
                { ...question, toolCallId: question.toolCallId },
                rewrite,
              );
              await pause();
              await interruptRun(context, runnerRunId);
              return;
            }
            yield chunk;
            if (chunk.outcome?.type === "interrupt") {
              await pause();
              return;
            }
            finished = true;
            continue;
          }
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest:
            // The chunk stream carries the interrupt the member answers.
            continue;
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished: {
            await pause();
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
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.hello:
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.harnessStatus:
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runAccepted:
          case DESKTOP_RUNNER_DESKTOP_MESSAGE.runRejected:
            return panic(`A run stored an unsequenced ${message.type}`);
          default:
            message satisfies never;
            return panic("Unknown stored desktop runner message");
        }
      }
      if (page.value.nextAfterSeq !== null) {
        continue;
      }
      const run = await control.readRun({ owner, runId: runnerRunId });
      if (run.isErr()) {
        throw run.error;
      }
      const step = caughtUpStep(run.value);
      switch (step.type) {
        case "fail":
          yield* fail(step.code);
          return;
        case "read":
          continue;
        case "wait":
          await listener.wait({
            timeoutMs: context.pollMs ?? DEFAULT_POLL_MS,
            signal: abortSignal,
          });
          continue;
        default:
          step satisfies never;
          return panic("Unknown caught-up step");
      }
    }
  } finally {
    listener.close();
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
    case undefined:
      return AI_FAILURE_CODES.local_runner_unavailable;
    default:
      state satisfies never;
      return panic("Unknown harness state");
  }
};

type StartOptions = {
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
  context,
  destination,
  input,
}: StartOptions): AsyncGenerator<PublicStreamChunk> {
  const { control, owner } = context;
  const session = await control.readChatRunSession({
    owner,
    chatThreadId: context.chatThreadId,
    desktopId: destination.desktopId,
    harness: destination.harness,
  });
  if (session.isErr()) {
    throw session.error;
  }
  const harnessSessionId = session.value;
  const start = async (messages: readonly ModelMessage[]) =>
    await control.startRun({
      owner,
      desktopId: destination.desktopId,
      harness: destination.harness,
      harnessVersion: destination.harnessVersion,
      model: destination.model,
      harnessSessionId,
      instructions: input.instructions,
      messages: messages.flatMap((message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "tool"
          ? [{ ...message, role: message.role }]
          : [],
      ),
      mcp: context.mcp,
      workspaceIds: context.workspaceIds,
      chatThreadId: context.chatThreadId,
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
  const rewrite = {
    chatRunId: input.chatRunId,
    threadId: context.chatThreadId,
  };
  const refuse = function* (code: LocalRunFailure) {
    yield {
      type: EventType.RUN_STARTED,
      runId: input.chatRunId,
      threadId: context.chatThreadId,
      timestamp: nowMs(),
    } as const satisfies PublicStreamChunk;
    yield* runErrorChunks(failureOf(code), rewrite);
  };
  if (started.isErr()) {
    if (started.error._tag === "DatabaseError") {
      throw started.error;
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
    case "too_large":
      yield* refuse(AI_FAILURE_CODES.local_runner_unavailable);
      return;
    default:
      outcome satisfies never;
      return panic("Unknown local run start outcome");
  }
}

/** Why answering the paused run failed, or `null` once every answer is queued. */
type ResumeFailure = LocalRunFailure | null;

type ResumeOptions = {
  context: LocalRunContext;
  input: LocalRunStreamInput & { resume: readonly RunAgentResumeItem[] };
};

/**
 * Answer the approvals the run paused for on the same run, then continue
 * reading it after where the paused turn stopped.
 *
 * @yields Chunks of the chat run, ending with its terminal one.
 */
async function* resumeLocalRun({
  context,
  input,
}: ResumeOptions): AsyncGenerator<PublicStreamChunk> {
  const { control, owner } = context;
  const uuid = v.pipe(v.string(), v.uuid());
  let runnerRunId: string | null = null;
  let afterSeq = 0;
  let failure: ResumeFailure = null;
  for (const item of input.resume) {
    // Approval request ids are minted as UUIDs by the runner protocol.
    if (!v.is(uuid, item.interruptId)) {
      failure = AI_FAILURE_CODES.local_runner_unavailable;
      break;
    }
    // db-await-in-loop: one answer per paused approval, each its own command
    const found = await control.readChatRunForRequest({
      owner,
      chatThreadId: context.chatThreadId,
      requestId: item.interruptId,
    });
    if (found.isErr()) {
      throw found.error;
    }
    const run = found.value;
    if (run === null || (runnerRunId !== null && run.runId !== runnerRunId)) {
      failure = AI_FAILURE_CODES.local_runner_unavailable;
      break;
    }
    runnerRunId = run.runId;
    afterSeq = run.chatReadSeq;
    // db-await-in-loop: one answer per paused approval, each its own command
    const answered = await control.answerApproval({
      owner,
      runId: run.runId,
      requestId: item.interruptId,
      decision: approvalDecisionOf(item),
    });
    if (answered.isErr()) {
      if (answered.error._tag === "DatabaseError") {
        throw answered.error;
      }
      failure = AI_FAILURE_CODES.local_runner_unavailable;
      break;
    }
    switch (answered.value.type) {
      case "queued":
      case "duplicate":
        continue;
      case "run_ended":
      case "run_not_found":
      case "approval_not_requested":
      case "command_limit":
      case "too_large":
        failure = AI_FAILURE_CODES.local_runner_unavailable;
        break;
      default:
        answered.value satisfies never;
        return panic("Unknown approval answer outcome");
    }
    if (failure !== null) {
      break;
    }
  }
  if (failure !== null || runnerRunId === null) {
    yield {
      type: EventType.RUN_STARTED,
      runId: input.chatRunId,
      threadId: context.chatThreadId,
      timestamp: nowMs(),
    };
    yield* runErrorChunks(
      failureOf(failure ?? AI_FAILURE_CODES.local_runner_unavailable),
      { chatRunId: input.chatRunId, threadId: context.chatThreadId },
    );
    return;
  }
  yield* readRunChunks({
    context,
    runnerRunId,
    afterSeq,
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
export const createLocalChatRun = (
  context: LocalRunContext,
  plan: LocalRunPlan,
): LocalChatRun => ({
  harness: plan.type === "start" ? plan.destination.harness : plan.harness,
  stream: (input) => {
    const { resume } = input;
    switch (plan.type) {
      case "start":
        return resume === undefined || resume.length === 0
          ? startLocalRun({ context, destination: plan.destination, input })
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
