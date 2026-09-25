import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk, TokenUsage } from "@tanstack/ai";
import { panic, TaggedError } from "better-result";

// A scripted provider: each provider iteration answers with the next scripted
// turn, in the chunk shapes a provider adapter emits. Everything above the
// adapter (the `chat()` loop, tool execution, approvals, persistence, the
// client-visible stream) stays the production code.

type ScriptedTurnUsage = Pick<
  TokenUsage,
  "completionTokens" | "promptTokens" | "totalTokens"
>;

/** One provider iteration of a scripted run. */
export type ScriptedTurn =
  | {
      arguments: string;
      /**
       * Defaults to `call-<iteration>`, which repeats across adapters. A test
       * that scripts several requests in one thread passes distinct ids, as a
       * provider would: approvals are keyed by tool-call id.
       */
      toolCallId?: string | undefined;
      toolName: string;
      type: "tool-call";
      usage?: ScriptedTurnUsage | undefined;
    }
  | {
      finishReason: "content_filter" | "length" | "stop";
      text: string;
      type: "text";
      usage?: ScriptedTurnUsage | undefined;
    }
  | {
      code?: string | undefined;
      message: string;
      type: "error";
    }
  | {
      /** The provider call fails before it yields anything. */
      message: string;
      type: "fail-before-output";
    }
  | {
      /** The provider call never answers, as when the process serving the
       *  run dies while it waits. */
      type: "stall";
    }
  | ScriptedStep;

/**
 * One provider iteration shaped like a reasoning model's: optional thinking,
 * optional text, then any number of tool calls in one response. With no tool
 * calls it ends the run as a text answer, cut off at the output limit when
 * `finishReason` is `length`.
 */
type ScriptedStep = {
  finishReason?: "length" | "stop" | undefined;
  reasoning?: string | undefined;
  /**
   * Where the provider goes quiet and stays quiet until the run is aborted
   * (a model call the user stops, or one whose connection drops): once the
   * first tool call's arguments have streamed but before the call ends, or
   * once every tool call has ended but before the step finishes.
   */
  quietUntilAborted?: "after-tool-end" | "before-tool-end" | undefined;
  text?: string | undefined;
  toolCalls: readonly {
    arguments: string;
    /**
     * The input the adapter hands the engine on `TOOL_CALL_END`, when it
     * differs from `arguments`: a strict-mode provider spells an absent
     * optional field `null` on the wire, and its adapter drops it.
     */
    input?: unknown;
    toolCallId: string;
    toolName: string;
  }[];
  type: "step";
  usage?: ScriptedTurnUsage | undefined;
};

const DEFAULT_TURN_USAGE = {
  completionTokens: 1,
  promptTokens: 1,
  totalTokens: 2,
} as const satisfies ScriptedTurnUsage;

/** Where a scripted turn runs: the provider call's model, run and thread. */
type ScriptedTurnContext = {
  /** The turn's position in its run, for ids that are stable per run. */
  index: number;
  model: string;
  runId: string;
  /** The run's abort signal, which a step gone quiet waits on. */
  signal?: AbortSignal | undefined;
  threadId: string;
};

/** Resolves once `signal` aborts. */
const untilAborted = async (signal: AbortSignal | undefined) =>
  await new Promise<void>((resolve) => {
    if (signal === undefined) {
      panic("A scripted step gone quiet needs the run's abort signal");
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });

/**
 * The events a provider adapter emits for one step, in the order the
 * Anthropic adapter emits them: the thinking block (with its signature), the
 * text block, then each tool call.
 *
 * @yields Each provider event of the step, ending with its `RUN_FINISHED`.
 */
async function* scriptedStepChunks({
  messageId,
  model,
  runId,
  signal,
  step,
  threadId,
  timestamp,
}: {
  messageId: string;
  model: string;
  runId: string;
  signal?: AbortSignal | undefined;
  step: ScriptedStep;
  threadId: string;
  timestamp: number;
}): AsyncGenerator<StreamChunk> {
  if (step.reasoning !== undefined) {
    // A provider mints a fresh id for every thinking block; message ids here
    // repeat across requests, so these must not derive from them.
    const blockId = Bun.randomUUIDv7();
    const reasoningId = `reasoning-${blockId}`;
    const stepId = `thinking-${blockId}`;
    yield {
      type: EventType.REASONING_START,
      messageId: reasoningId,
      model,
      timestamp,
    };
    yield {
      type: EventType.REASONING_MESSAGE_START,
      messageId: reasoningId,
      role: "reasoning",
      model,
      timestamp,
    };
    yield {
      type: EventType.STEP_STARTED,
      stepName: stepId,
      stepId,
      model,
      timestamp,
      stepType: "thinking",
    };
    yield {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: reasoningId,
      delta: step.reasoning,
      model,
      timestamp,
    };
    yield {
      type: EventType.STEP_FINISHED,
      stepName: stepId,
      stepId,
      model,
      timestamp,
      delta: step.reasoning,
      content: step.reasoning,
    };
    yield {
      type: EventType.STEP_FINISHED,
      stepName: stepId,
      stepId,
      model,
      timestamp,
      delta: "",
      content: step.reasoning,
      signature: `signature-${stepId}`,
    };
    yield {
      type: EventType.REASONING_MESSAGE_END,
      messageId: reasoningId,
      model,
      timestamp,
    };
    yield {
      type: EventType.REASONING_END,
      messageId: reasoningId,
      model,
      timestamp,
    };
  }
  if (step.text !== undefined) {
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      model,
      timestamp,
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: step.text,
      model,
      timestamp,
    };
    yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp };
  }
  for (const call of step.toolCalls) {
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: call.toolCallId,
      toolCallName: call.toolName,
      parentMessageId: messageId,
      timestamp,
    };
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: call.toolCallId,
      delta: call.arguments,
      model,
      timestamp,
    };
    if (step.quietUntilAborted === "before-tool-end") {
      await untilAborted(signal);
      return;
    }
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId: call.toolCallId,
      timestamp,
      ...(call.input === undefined
        ? {}
        : {
            input: call.input,
            toolCallName: call.toolName,
            toolName: call.toolName,
          }),
    };
  }
  if (step.quietUntilAborted === "after-tool-end") {
    await untilAborted(signal);
    return;
  }
  yield {
    type: EventType.RUN_FINISHED,
    runId,
    threadId,
    finishReason:
      step.toolCalls.length > 0 ? "tool_calls" : (step.finishReason ?? "stop"),
    model,
    timestamp,
    usage: step.usage ?? DEFAULT_TURN_USAGE,
  };
}

/** A scripted provider call that fails, as a provider's transport would. */
export class ScriptedProviderError extends TaggedError(
  "ScriptedProviderError",
)<{ message: string }> {}

/**
 * The provider events for one scripted turn.
 *
 * @yields Each provider event of the turn, from `RUN_STARTED` on.
 */
export async function* scriptedTurnChunks(
  turn: ScriptedTurn,
  { index, model, runId, signal, threadId }: ScriptedTurnContext,
): AsyncGenerator<StreamChunk> {
  // A provider answers asynchronously; so does the script.
  await Promise.resolve();
  if (turn.type === "fail-before-output") {
    throw new ScriptedProviderError({ message: turn.message });
  }
  if (turn.type === "stall") {
    await Promise.withResolvers<never>().promise;
    return;
  }
  const messageId = `provider-message-${String(index + 1)}`;
  const timestamp = Date.now();
  yield {
    type: EventType.RUN_STARTED,
    runId,
    threadId,
    model,
    timestamp,
  } satisfies StreamChunk;
  switch (turn.type) {
    case "tool-call": {
      yield* scriptedStepChunks({
        messageId,
        model,
        runId,
        step: {
          toolCalls: [
            {
              arguments: turn.arguments,
              toolCallId: turn.toolCallId ?? `call-${String(index + 1)}`,
              toolName: turn.toolName,
            },
          ],
          type: "step",
          usage: turn.usage,
        },
        threadId,
        timestamp,
      });
      return;
    }
    case "text": {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        model,
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: turn.text,
        model,
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        finishReason: turn.finishReason,
        model,
        timestamp,
        usage: turn.usage ?? DEFAULT_TURN_USAGE,
      } satisfies StreamChunk;
      return;
    }
    case "step": {
      yield* scriptedStepChunks({
        messageId,
        model,
        runId,
        signal,
        step: turn,
        threadId,
        timestamp,
      });
      return;
    }
    case "error": {
      yield {
        type: EventType.RUN_ERROR,
        message: turn.message,
        ...(turn.code === undefined ? {} : { code: turn.code }),
        model,
        timestamp,
      } satisfies StreamChunk;
      return;
    }
    default: {
      turn satisfies never;
      panic("Unhandled scripted turn");
    }
  }
}

/** The adapter shape every scripted provider shares; only `chatStream`
 *  differs. */
export const scriptedAdapterBase = {
  kind: "text",
  name: "scripted",
  model: "scripted",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
} as const;

/**
 * A text adapter answering the n-th provider iteration with the n-th scripted
 * turn. Throws when the loop asks for more iterations than were scripted, so a
 * run that re-calls the model unexpectedly fails loudly.
 */
export const createScriptedTextAdapter = (
  turns: readonly ScriptedTurn[],
): AnyTextAdapter => {
  let turnIndex = 0;
  return {
    ...scriptedAdapterBase,
    async *chatStream({ model, runId, threadId }) {
      const index = turnIndex;
      turnIndex += 1;
      const turn = turns.at(index);
      if (turn === undefined) {
        panic("The scripted adapter ran out of turns");
      }
      yield* scriptedTurnChunks(turn, {
        index,
        model,
        runId: runId ?? "run-1",
        threadId: threadId ?? "thread-1",
      });
    },
    structuredOutput: () =>
      panic("Structured output is not part of the scripted adapter"),
  };
};

/** Read a streamed response to its end, so its terminal persistence runs. */
export const drainResponse = async (response: Response): Promise<string> =>
  await response.text();
