import {
  type AdapterYieldChunk,
  buildBaseUsage,
  EventType,
  normalizeStreamChunk,
  type StreamChunk,
  type TokenUsage,
} from "@tanstack/ai";
import { panic } from "better-result";

import {
  type AgentHarness,
  harnessSessionIdEvent,
} from "@stll/api-contract/agent-harness";
import { AI_FAILURE_CODES } from "@stll/api-contract/ai-errors";
import {
  DESKTOP_RUNNER_REQUEST_EVENT,
  type DesktopRunnerRequestEvent,
} from "@stll/api-contract/chat-local-run-request";
import {
  CHAT_LOCAL_RUN_INTERRUPT_REASONS,
  CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY,
  chatLocalRunApprovalReason,
} from "@stll/api-contract/chat-local-run-tool";
import {
  CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY,
  CHAT_LOCAL_RUN_LIMIT_METADATA_KEY,
  CHAT_LOCAL_RUN_MODEL_METADATA_KEY,
  CHAT_LOCAL_RUN_QUESTION_TOOL,
  type ChatLocalRunContext,
  type ChatLocalRunLimit,
  type ChatLocalRunModel,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_INPUT_EVENT,
  type DesktopRunnerInputEvent,
} from "@stll/api-contract/desktop-runner";

import {
  approvalMessage,
  type HarnessApprovalRequest,
  type HarnessEvent,
  type HarnessFailure,
  type HarnessInteractionClosed,
  type HarnessQuestionRequest,
  type HarnessToolCall,
  type HarnessToolResult,
  type HarnessUsage,
} from "./events";
import { shownToolInput, shownToolResult } from "./tool-parts";

/**
 * The one mapping from harness events to TanStack stream chunks for local
 * runs. It follows the cloud Codex translator in `@tanstack/ai-codex`
 * (`translateThreadEvents`): harness tools appear as already-resolved tool
 * calls, every started tool call is paired with a result before the stream
 * ends, and the native session id rides a `<harness>.session-id` CUSTOM
 * event. A local and a cloud turn therefore fold into the same message.
 *
 * A pending approval or blocking question is announced the AG-UI way:
 * `RUN_FINISHED` with an `interrupt` outcome naming the tool call, which
 * closes a run segment. It does not end the turn: the harness may go on
 * while the request waits (other steps, its final answer), and whatever it
 * does next arrives in a new segment on the same stream. The mapper owns
 * the request until it closes: an answer or a withdrawal reports its end
 * (`DESKTOP_RUNNER_REQUEST_EVENT`), and the turn's end closes every request
 * still open, so none outlives its run.
 */

/** CUSTOM event reporting how the turn's context was established. */
export const HARNESS_CONTINUATION_EVENT = "harness.continuation";

/** Tool name for a harness question, matching Codex's native item name. */
export const HARNESS_QUESTION_TOOL = CHAT_LOCAL_RUN_QUESTION_TOOL;

export type HarnessChunkContext = {
  harness: AgentHarness;
  model: string;
  runId: string;
  threadId: string;
  /**
   * The run's folder: a native step's file names are reported relative to
   * it.
   */
  workspaceDir: string;
  generateId: () => string;
  now: () => number;
};

const FAILURE_CODE = {
  auth_required: "harness.auth_required",
  usage_limit: "harness.usage_limit",
  // The provider's own transient outage, not the harness's: the chat's code
  // for it, so the member reads "try again in a moment".
  model_at_capacity: AI_FAILURE_CODES.provider_unavailable,
  provider_error: "harness.provider_error",
  harness_exited: "harness.exited",
  protocol_violation: "harness.protocol_violation",
  sandbox_unavailable: "harness.sandbox_unavailable",
  retry_stalled: "harness.retry_stalled",
  request_unanswered: "harness.request_unanswered",
  tools_unavailable: "harness.tools_unavailable",
} as const satisfies Record<HarnessFailure["type"], string>;

const toTokenUsage = (usage: HarnessUsage): TokenUsage => {
  const result = buildBaseUsage({
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  });
  if (usage.cachedInputTokens > 0) {
    result.promptTokensDetails = { cachedTokens: usage.cachedInputTokens };
  }
  if (usage.reasoningOutputTokens > 0) {
    result.completionTokensDetails = {
      reasoningTokens: usage.reasoningOutputTokens,
    };
  }
  return result;
};

/**
 * How a tool call ended. `cancelled`: its turn ended before it finished; like
 * the cloud engine's cancelled results, it is an error with that outcome, so
 * it never reads as complete.
 */
type ToolResultStatus = "succeeded" | "failed" | "cancelled";

const TOOL_RESULT_FIELDS = {
  succeeded: {},
  failed: { state: "output-error" },
  cancelled: {
    state: "output-error",
    metadata: { tanstack: { toolResultOutcome: "cancelled" } },
  },
} as const satisfies Record<ToolResultStatus, object>;

/**
 * A cancelled call's result content, whatever the harness sent with it: a
 * call the turn cut off never ran to its end, so its card reads as stopped,
 * never as failed.
 */
const INTERRUPTED_RESULT_CONTENT = JSON.stringify({ status: "interrupted" });

type TextState = { text: string; emitted: number; ended: boolean };

/** What a request's end reports, beside its id. */
type DesktopRunnerRequestClosed = DistributiveOmit<
  DesktopRunnerRequestEvent,
  "requestId"
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** How a request the harness closed while its turn went on ends. */
const REQUEST_CLOSED = {
  answered: { status: "resolved" },
  stopped: { status: "cancelled" },
  withdrawn: { status: "expired", expiry: "withdrawn" },
} as const satisfies Record<
  HarnessInteractionClosed,
  DesktopRunnerRequestClosed
>;

/** How the turn's end closes a request still open. */
const REQUEST_CLOSED_BY_END = {
  completed: { status: "expired", expiry: "run_finished" },
  interrupted: { status: "cancelled" },
  failed: { status: "expired", expiry: "run_failed" },
} as const satisfies Record<string, DesktopRunnerRequestClosed>;

class ChunkMapper {
  private readonly out: AdapterYieldChunk[] = [];
  private segment = 0;
  private segmentOpen = false;
  private terminated = false;
  /** Tool calls opened in this turn. */
  private readonly opened = new Set<string>();
  /** Opened tool calls that still have no result. */
  private readonly unresolved = new Set<string>();
  private readonly texts = new Map<string, TextState>();
  /** Requests announced and not closed yet: the member may still answer. */
  private readonly openRequests = new Set<string>();

  private readonly context: HarnessChunkContext;
  /** The model the turn runs on: the one asked for until a reroute. */
  private model: string;

  constructor(context: HarnessChunkContext) {
    this.context = context;
    this.model = context.model;
  }

  map(event: HarnessEvent): AdapterYieldChunk[] {
    if (!this.terminated) {
      this.apply(event);
    }
    return this.out.splice(0);
  }

  /** A stream that ends without a terminal event broke the adapter contract. */
  finish(): AdapterYieldChunk[] {
    if (!this.terminated) {
      this.ensureSegment();
      this.terminate(
        REQUEST_CLOSED_BY_END.failed,
        this.runError({
          type: "protocol_violation",
          message: "The harness event stream ended before the turn finished.",
        }),
      );
    }
    return this.out.splice(0);
  }

  private apply(event: HarnessEvent) {
    switch (event.type) {
      case "session.started":
        this.ensureSegment();
        this.push(
          {
            type: EventType.CUSTOM,
            name: harnessSessionIdEvent(this.context.harness),
            value: { sessionId: event.sessionId },
          },
          {
            type: EventType.CUSTOM,
            name: HARNESS_CONTINUATION_EVENT,
            value: event.continuation,
          },
        );
        return;
      case "text.delta": {
        const current = this.texts.get(event.messageId)?.text ?? "";
        this.text(event.messageId, current + event.delta);
        return;
      }
      case "text.completed":
        this.text(event.messageId, event.text);
        this.endText(event.messageId);
        return;
      case "reasoning.completed":
        this.reasoning(event.messageId, event.text);
        return;
      case "tool.started":
        this.ensureSegment();
        this.openToolCall(event.toolCall);
        return;
      case "tool.completed":
        this.completeToolCall(event.toolCall, event.result);
        return;
      case "approval.requested":
        this.pauseForApproval(event.request);
        return;
      case "question.requested":
        this.question(event.request);
        return;
      case "model.rerouted":
        this.model = event.model;
        return;
      case "interaction.resolved":
        this.closeRequest(
          event.requestId,
          event.decision === undefined
            ? REQUEST_CLOSED[event.closed ?? "answered"]
            : { status: "resolved", decision: event.decision },
        );
        break;
      case "retrying":
        // The harness continues on its own; its next output opens a new
        // segment. A transient retry leaves nothing to persist.
        return;
      case "input.settled":
        // Where the turn took (or refused) a steering message. It names the
        // input only: the API holds the text it sent.
        this.ensureSegment();
        this.push({
          type: EventType.CUSTOM,
          name: DESKTOP_RUNNER_INPUT_EVENT,
          value: {
            inputId: event.inputId,
            status: event.status,
          } satisfies DesktopRunnerInputEvent,
        });
        return;
      case "turn.completed": {
        // How full the context is, for the chat's meter.
        const context: ChatLocalRunContext | null =
          event.usage?.context ?? null;
        this.ensureSegment();
        this.terminate(
          REQUEST_CLOSED_BY_END.completed,
          this.runFinished({
            finishReason: "stop",
            ...(event.usage === null
              ? {}
              : { usage: toTokenUsage(event.usage) }),
            ...(context === null
              ? {}
              : {
                  metadata: { [CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY]: context },
                }),
          }),
        );
        return;
      }
      case "turn.interrupted":
        this.ensureSegment();
        this.terminate(
          REQUEST_CLOSED_BY_END.interrupted,
          this.runFinished({
            finishReason: "stop",
            outcome: { type: "cancelled" },
          }),
        );
        return;
      case "turn.failed":
        this.ensureSegment();
        this.terminate(
          REQUEST_CLOSED_BY_END.failed,
          this.runError(event.failure),
        );
        return;
      default:
        event satisfies never;
        panic("Unhandled harness event");
    }
  }

  /**
   * Stamp the model and time every chunk carries, as the cloud engine does:
   * the model that ran, which a reroute changes.
   */
  private push(...chunks: AdapterYieldChunk[]) {
    for (const chunk of chunks) {
      this.out.push({
        ...chunk,
        model: this.model,
        timestamp: this.context.now(),
      });
    }
  }

  private segmentRunId() {
    return this.segment === 0
      ? this.context.runId
      : `${this.context.runId}:${this.segment}`;
  }

  private ensureSegment() {
    if (this.segmentOpen) {
      return;
    }
    this.segmentOpen = true;
    this.push({
      type: EventType.RUN_STARTED,
      runId: this.segmentRunId(),
      threadId: this.context.threadId,
    });
  }

  private closeSegment(chunk: AdapterYieldChunk) {
    this.out.push(chunk);
    this.segmentOpen = false;
    this.segment += 1;
  }

  private runFinished(fields: {
    finishReason: "stop" | "tool_calls";
    usage?: TokenUsage;
    metadata?: Record<string, unknown>;
    outcome?: NonNullable<
      Extract<StreamChunk, { type: EventType.RUN_FINISHED }>["outcome"]
    >;
  }): AdapterYieldChunk {
    const { metadata, ...rest } = fields;
    return {
      type: EventType.RUN_FINISHED,
      runId: this.segmentRunId(),
      threadId: this.context.threadId,
      model: this.model,
      timestamp: this.context.now(),
      ...rest,
      // The answer says when a reroute ran it on another model than asked.
      metadata: {
        ...metadata,
        [CHAT_LOCAL_RUN_MODEL_METADATA_KEY]: {
          requested: this.context.model,
          ran: this.model,
        } satisfies ChatLocalRunModel,
      },
    };
  }

  private runError(failure: HarnessFailure): AdapterYieldChunk {
    const code = FAILURE_CODE[failure.type];
    return {
      type: EventType.RUN_ERROR,
      runId: this.segmentRunId(),
      threadId: this.context.threadId,
      model: this.model,
      timestamp: this.context.now(),
      message: failure.message,
      code,
      error: { message: failure.message, code },
      // When a usage limit resets, so the chat can say when to try again.
      ...(failure.type === "usage_limit" && failure.resetsAt !== null
        ? {
            metadata: {
              [CHAT_LOCAL_RUN_LIMIT_METADATA_KEY]: {
                resetsAt: failure.resetsAt,
              } satisfies ChatLocalRunLimit,
            },
          }
        : {}),
    };
  }

  private openToolCall(toolCall: HarnessToolCall) {
    if (this.opened.has(toolCall.id)) {
      return;
    }
    this.opened.add(toolCall.id);
    this.unresolved.add(toolCall.id);
    const input = this.shownInput(toolCall);
    const args = input === undefined ? "{}" : JSON.stringify(input);
    this.push(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: toolCall.id,
        toolCallName: toolCall.name,
        // The subagent step that made the call, beside it: the API keeps
        // the link under that step's chat call id.
        ...(toolCall.parentCallId === undefined
          ? {}
          : {
              metadata: {
                [CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY]:
                  toolCall.parentCallId,
              },
            }),
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: toolCall.id,
        delta: args,
        args,
      },
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: toolCall.id,
        toolCallName: toolCall.name,
        input,
      },
    );
  }

  private shownInput(toolCall: HarnessToolCall) {
    return shownToolInput(toolCall, this.context.workspaceDir);
  }

  private resolveToolCall(
    toolCallId: string,
    content: string,
    status: ToolResultStatus,
  ) {
    this.unresolved.delete(toolCallId);
    this.push({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: this.context.generateId(),
      content,
      ...TOOL_RESULT_FIELDS[status],
    });
  }

  private completeToolCall(
    toolCall: HarnessToolCall,
    result: HarnessToolResult,
  ) {
    if (this.opened.has(toolCall.id) && !this.unresolved.has(toolCall.id)) {
      // One result per call: a repeat would persist a second result part.
      return;
    }
    this.ensureSegment();
    this.openToolCall(toolCall);
    this.resolveToolCall(
      toolCall.id,
      result.status === "cancelled"
        ? INTERRUPTED_RESULT_CONTENT
        : shownToolResult(
            toolCall,
            result.content,
            result.status === "failed",
            this.context.workspaceDir,
          ),
      result.status,
    );
  }

  private text(messageId: string, fullText: string) {
    this.ensureSegment();
    const existing = this.texts.get(messageId);
    const state = existing ?? { text: "", emitted: 0, ended: false };
    if (existing === undefined) {
      this.texts.set(messageId, state);
      this.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      });
    }
    state.text = fullText;
    if (state.ended || fullText.length <= state.emitted) {
      return;
    }
    const delta = fullText.slice(state.emitted);
    state.emitted = fullText.length;
    this.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
      content: fullText,
    });
  }

  private endText(messageId: string) {
    const state = this.texts.get(messageId);
    if (state === undefined || state.ended) {
      return;
    }
    state.ended = true;
    this.push({ type: EventType.TEXT_MESSAGE_END, messageId });
  }

  private reasoning(messageId: string, text: string) {
    this.ensureSegment();
    this.push(
      { type: EventType.REASONING_START, messageId },
      { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: text },
      { type: EventType.REASONING_MESSAGE_END, messageId },
      { type: EventType.REASONING_END, messageId },
    );
  }

  private pauseForApproval(request: HarnessApprovalRequest) {
    this.ensureSegment();
    this.openToolCall(request.toolCall);
    this.openRequests.add(request.requestId);
    this.closeSegment(
      this.runFinished({
        finishReason: "tool_calls",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: request.requestId,
              reason: CHAT_LOCAL_RUN_INTERRUPT_REASONS.approval,
              message: approvalMessage(request),
              toolCallId: request.toolCall.id,
              metadata: {
                kind: "approval",
                reason: chatLocalRunApprovalReason(request.reason),
                toolName: request.toolCall.name,
                input: this.shownInput(request.toolCall),
                approvalKind: request.kind,
                decisions: request.options.map(({ decision }) => decision),
              },
            },
          ],
        },
      }),
    );
  }

  private question(request: HarnessQuestionRequest) {
    this.ensureSegment();
    this.openToolCall(request.toolCall);
    if (request.answerWith === "next_message") {
      // Answered by the user's next message, not by this turn: the call is
      // complete, so a later turn on any engine sees no open call.
      this.resolveToolCall(
        request.toolCall.id,
        JSON.stringify({
          status: "awaiting_reply",
          questions: request.questions,
        }),
        "succeeded",
      );
      return;
    }
    this.openRequests.add(request.requestId);
    this.closeSegment(
      this.runFinished({
        finishReason: "tool_calls",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: request.requestId,
              reason: CHAT_LOCAL_RUN_INTERRUPT_REASONS.question,
              message: request.questions.map(({ prompt }) => prompt).join("\n"),
              toolCallId: request.toolCall.id,
              metadata: {
                kind: "question",
                toolName: request.toolCall.name,
                questions: request.questions,
              },
            },
          ],
        },
      }),
    );
  }

  /** Report that request `requestId` closed; nothing for one never open. */
  private closeRequest(requestId: string, closed: DesktopRunnerRequestClosed) {
    if (!this.openRequests.delete(requestId)) {
      return;
    }
    this.ensureSegment();
    this.push({
      type: EventType.CUSTOM,
      name: DESKTOP_RUNNER_REQUEST_EVENT,
      value: { requestId, ...closed } satisfies DesktopRunnerRequestEvent,
    });
  }

  private terminate(
    closed: DesktopRunnerRequestClosed,
    chunk: AdapterYieldChunk,
  ) {
    for (const messageId of this.texts.keys()) {
      this.endText(messageId);
    }
    // The turn's end closes every request still open: the run no longer
    // waits for any answer.
    for (const requestId of [...this.openRequests]) {
      this.closeRequest(requestId, closed);
    }
    // Pair every open tool call before the run ends, as the cloud engine does.
    for (const toolCallId of [...this.unresolved]) {
      this.resolveToolCall(toolCallId, INTERRUPTED_RESULT_CONTENT, "cancelled");
    }
    this.closeSegment(chunk);
    this.terminated = true;
  }
}

/**
 * Map a turn's harness events to normalized stream chunks: the public
 * StreamChunk form `chat()` yields for a cloud harness turn.
 *
 * @yields One normalized chunk at a time, ending with the turn's terminal one.
 */
export async function* harnessEventsToChunks(
  events: AsyncIterable<HarnessEvent>,
  context: HarnessChunkContext,
): AsyncGenerator<StreamChunk> {
  const mapper = new ChunkMapper(context);
  for await (const event of events) {
    for (const chunk of mapper.map(event)) {
      yield* normalizeStreamChunk(chunk);
    }
  }
  for (const chunk of mapper.finish()) {
    yield* normalizeStreamChunk(chunk);
  }
}
