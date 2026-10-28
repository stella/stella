import {
  type AdapterYieldChunk,
  buildBaseUsage,
  EventType,
  normalizeStreamChunk,
  type StreamChunk,
  type TokenUsage,
} from "@tanstack/ai";
import { panic } from "better-result";

import type { AgentHarness } from "@stll/api-contract/agent-harness";

import type {
  HarnessApprovalRequest,
  HarnessEvent,
  HarnessFailure,
  HarnessQuestionRequest,
  HarnessToolCall,
  HarnessUsage,
} from "./events";

/**
 * The one mapping from harness events to TanStack stream chunks for local
 * runs. It follows the cloud Codex translator in `@tanstack/ai-codex`
 * (`translateThreadEvents`): harness tools appear as already-resolved tool
 * calls, every started tool call is paired with a result before the stream
 * ends, and the native session id rides a `<harness>.session-id` CUSTOM
 * event. A local and a cloud turn therefore fold into the same message.
 *
 * A pending approval or blocking question pauses the run the AG-UI way:
 * `RUN_FINISHED` with an `interrupt` outcome naming the tool call. The harness
 * keeps waiting meanwhile; whatever it does after the answer arrives in a new
 * run segment on the same stream.
 */

/** CUSTOM event reporting how the turn's context was established. */
export const HARNESS_CONTINUATION_EVENT = "harness.continuation";

/** Tool name for a harness question, matching Codex's native item name. */
export const HARNESS_QUESTION_TOOL = "request_user_input";

export type HarnessChunkContext = {
  harness: AgentHarness;
  model: string;
  runId: string;
  threadId: string;
  generateId: () => string;
  now: () => number;
};

const FAILURE_CODE = {
  auth_required: "harness.auth_required",
  usage_limit: "harness.usage_limit",
  provider_error: "harness.provider_error",
  harness_exited: "harness.exited",
  protocol_violation: "harness.protocol_violation",
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

type TextState = { text: string; emitted: number; ended: boolean };

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

  private readonly context: HarnessChunkContext;

  constructor(context: HarnessChunkContext) {
    this.context = context;
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
            name: `${this.context.harness}.session-id`,
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
      case "interaction.resolved":
      case "retrying":
        // The harness continues on its own; its next output opens a new
        // segment. A transient retry leaves nothing to persist.
        return;
      case "turn.completed":
        this.ensureSegment();
        this.terminate(
          this.runFinished({
            finishReason: "stop",
            ...(event.usage === null
              ? {}
              : { usage: toTokenUsage(event.usage) }),
          }),
        );
        return;
      case "turn.interrupted":
        this.ensureSegment();
        this.terminate(
          this.runFinished({
            finishReason: "stop",
            outcome: { type: "cancelled" },
          }),
        );
        return;
      case "turn.failed":
        this.ensureSegment();
        this.terminate(this.runError(event.failure));
        return;
      default:
        event satisfies never;
        panic("Unhandled harness event");
    }
  }

  /** Stamp the model and time every chunk carries, as the cloud engine does. */
  private push(...chunks: AdapterYieldChunk[]) {
    for (const chunk of chunks) {
      this.out.push({
        ...chunk,
        model: this.context.model,
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
    outcome?: NonNullable<
      Extract<StreamChunk, { type: EventType.RUN_FINISHED }>["outcome"]
    >;
  }): AdapterYieldChunk {
    return {
      type: EventType.RUN_FINISHED,
      runId: this.segmentRunId(),
      threadId: this.context.threadId,
      model: this.context.model,
      timestamp: this.context.now(),
      ...fields,
    };
  }

  private runError(failure: HarnessFailure): AdapterYieldChunk {
    const code = FAILURE_CODE[failure.type];
    return {
      type: EventType.RUN_ERROR,
      runId: this.segmentRunId(),
      threadId: this.context.threadId,
      model: this.context.model,
      timestamp: this.context.now(),
      message: failure.message,
      code,
      error: { message: failure.message, code },
    };
  }

  private openToolCall(toolCall: HarnessToolCall) {
    if (this.opened.has(toolCall.id)) {
      return;
    }
    this.opened.add(toolCall.id);
    this.unresolved.add(toolCall.id);
    const args = JSON.stringify(toolCall.input) ?? "{}";
    this.push(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: toolCall.id,
        toolCallName: toolCall.name,
        toolName: toolCall.name,
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
        toolName: toolCall.name,
        input: toolCall.input,
      },
    );
  }

  private resolveToolCall(
    toolCallId: string,
    content: string,
    failed: boolean,
  ) {
    this.unresolved.delete(toolCallId);
    this.push({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: this.context.generateId(),
      content,
      ...(failed ? { state: "output-error" as const } : {}),
    });
  }

  private completeToolCall(
    toolCall: HarnessToolCall,
    result: { content: string; status: "succeeded" | "failed" },
  ) {
    if (this.opened.has(toolCall.id) && !this.unresolved.has(toolCall.id)) {
      // One result per call: a repeat would persist a second result part.
      return;
    }
    this.ensureSegment();
    this.openToolCall(toolCall);
    this.resolveToolCall(
      toolCall.id,
      result.content,
      result.status === "failed",
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
    this.closeSegment(
      this.runFinished({
        finishReason: "tool_calls",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: request.requestId,
              reason: "tool_call",
              message:
                request.reason ??
                `Approval required to run ${request.toolCall.name}`,
              toolCallId: request.toolCall.id,
              metadata: {
                kind: "approval",
                toolName: request.toolCall.name,
                input: request.toolCall.input,
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
        false,
      );
      return;
    }
    this.closeSegment(
      this.runFinished({
        finishReason: "tool_calls",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: request.requestId,
              reason: "user_input",
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

  private terminate(chunk: AdapterYieldChunk) {
    for (const messageId of this.texts.keys()) {
      this.endText(messageId);
    }
    // Pair every open tool call before the run ends, as the cloud engine does.
    for (const toolCallId of [...this.unresolved]) {
      this.resolveToolCall(
        toolCallId,
        JSON.stringify({ status: "interrupted" }),
        false,
      );
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
