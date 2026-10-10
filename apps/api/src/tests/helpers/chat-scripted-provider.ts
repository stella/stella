import { EventType } from "@tanstack/ai";
import type {
  AdapterYieldChunk,
  AnyTextAdapter,
  ModelMessage,
} from "@tanstack/ai";

import { stableStringify } from "@stll/stable-stringify";

import { mockStructuredData } from "@/api/dev/register-mock-ai";
import { env } from "@/api/env";
import { toJsonValue } from "@/api/lib/json-value";
import { registerTanStackMockTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import {
  createPromptPrefixLedger,
  promptBlocksOf,
} from "@/api/tests/helpers/chat-prompt-prefix";
import type { PromptPrefixLedger } from "@/api/tests/helpers/chat-prompt-prefix";
import {
  ScriptedProviderError,
  scriptedAdapterBase,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import type {
  ProducedStep,
  ProviderRequest,
} from "@/api/tests/helpers/provider-request-transcript";

// The scripted model behind the production chat pipeline. It registers
// through the same seam the local mock model uses
// (`registerTanStackMockTextAdapterFactory`), so a request runs through the
// real `streamChat`: model resolution, the third-party boundary, the `chat()`
// loop, persistence and the client-visible stream. Scripts are scoped to a
// thread and consumed one per request (one run id), in order; a request with
// no script left, or a script no request consumed, is a finding. Calls made
// outside a scripted thread (the thread title) are side calls and answered
// generically.
//
// Model resolution keeps the adapter it built, so there is one adapter per
// process, and each scripted thread keeps its own queue.

export type ScriptedRun = readonly ScriptedTurn[];

type ScriptedProviderFindings = {
  /** Tool results a model call was handed that differ from the one an
   *  earlier call of the thread was handed for the same tool call. */
  changedToolResults: unknown[];
  /** Provider calls for a scripted thread after its scripts ran out. */
  unscriptedCalls: string[];
  /** Scripts no request consumed. */
  unconsumedScripts: string[];
};

const SIDE_CALL_TEXT = "Scripted side answer";

type ThreadScripts = {
  /** See `ScriptedProviderFindings`. */
  changedToolResults: unknown[];
  /** The provider options of every model call the thread made, in order. */
  modelOptions: unknown[];
  /** Resolves the current `stalled` promise and arms the next one. */
  onStall: () => void;
  /** The prompt of every scripted model call, in order, as blocks
   *  (`chat.provider.prefix-stable`). */
  promptLedger: PromptPrefixLedger;
  /** What each of the thread's model calls produced, in order. */
  produced: ProducedStep[];
  /** The prompt of every model call the thread made, in order. */
  prompts: string[][];
  queue: ScriptedRun[];
  /** The model calls not yet taken by `takeRequests`, as handed to the
   *  provider. */
  requests: ProviderRequest[];
  /** Resolves once a request on the thread reaches a stalling turn. */
  stalled: Promise<undefined>;
  /** Per tool call id: the result the first model call that held one was
   *  handed. */
  toolResults: Map<string, string>;
  unscriptedCalls: string[];
};

const newThreadScripts = (): ThreadScripts => {
  const scripts: ThreadScripts = {
    changedToolResults: [],
    modelOptions: [],
    onStall: () => undefined,
    promptLedger: createPromptPrefixLedger(),
    produced: [],
    prompts: [],
    queue: [],
    requests: [],
    stalled: Promise.resolve(undefined),
    toolResults: new Map(),
    unscriptedCalls: [],
  };
  const arm = () => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    scripts.stalled = promise;
    scripts.onStall = () => {
      resolve(undefined);
      arm();
    };
  };
  arm();
  return scripts;
};

/**
 * A tool result's content as the model reads it: text exactly as handed over
 * (its JSON keys are sorted before any request, so a stored result reads the
 * same as the live one), parts with their keys in canonical order, since the
 * provider adapter writes their fields itself.
 */
const resultIdentity = (content: ModelMessage["content"]): string =>
  typeof content === "string"
    ? JSON.stringify(content)
    : stableStringify(toJsonValue(content));

/**
 * Records each tool result of an earlier turn that `messages` hands the
 * model, and a finding for one that differs from what an earlier model call
 * of the thread was handed: once a turn is over, every later request shows
 * the model its calls the same way. The current turn's own calls, after the
 * latest user message, are left out: a run may hand the model a result it
 * then fails to store, and the thread keeps what it stored.
 */
const recordToolResults = (
  scripts: ThreadScripts,
  messages: readonly ModelMessage[],
): void => {
  const currentTurn = messages.findLastIndex(({ role }) => role === "user");
  for (const message of messages.slice(0, Math.max(currentTurn, 0))) {
    if (message.role !== "tool" || message.toolCallId === undefined) {
      continue;
    }
    const handed = resultIdentity(message.content);
    const first = scripts.toolResults.get(message.toolCallId);
    if (first === undefined) {
      scripts.toolResults.set(message.toolCallId, handed);
    } else if (first !== handed) {
      scripts.changedToolResults.push({
        first,
        later: handed,
        toolCallId: message.toolCallId,
      });
    }
  }
};

/**
 * A model call's prompt as the provider reads it, one entry per message: no
 * ids or timestamps beyond the tool-call ids the provider pairs results by,
 * and each tool result up to key order, as `resultIdentity` reads it.
 */
const promptOf = (messages: readonly ModelMessage[]): string[] =>
  messages.map((message) =>
    stableStringify(
      toJsonValue({
        content:
          message.role === "tool"
            ? resultIdentity(message.content)
            : message.content,
        role: message.role,
        toolCallId: message.toolCallId,
        toolCalls: message.toolCalls?.map((call) => ({
          arguments: call.function.arguments,
          id: call.id,
          name: call.function.name,
        })),
      }),
    ),
  );

const threads = new Map<string, ThreadScripts>();
/** Per run: the script it took and the next iteration to answer. */
const runs = new Map<string, { index: number; run: ScriptedRun }>();

/**
 * Passes `chunks` through, recording into `step` the signed thinking and the
 * tool calls they produce.
 *
 * @yields Each chunk of `chunks`, unchanged.
 */
async function* recordingProduced(
  chunks: AsyncIterable<AdapterYieldChunk>,
  step: { signatures: string[]; toolCallIds: string[] },
): AsyncGenerator<AdapterYieldChunk> {
  for await (const chunk of chunks) {
    if (
      chunk.type === EventType.STEP_FINISHED &&
      chunk.signature !== undefined
    ) {
      step.signatures.push(chunk.signature);
    }
    if (chunk.type === EventType.TOOL_CALL_START) {
      step.toolCallIds.push(chunk.toolCallId);
    }
    yield chunk;
  }
}

const adapter: AnyTextAdapter = {
  ...scriptedAdapterBase,
  async *chatStream({
    messages,
    model,
    modelOptions,
    request,
    runId,
    systemPrompts,
    threadId,
    tools,
  }) {
    const scripts = threadId === undefined ? undefined : threads.get(threadId);
    scripts?.modelOptions.push(modelOptions);
    scripts?.requests.push({
      earlierSteps: [...scripts.produced],
      format: "model-messages",
      // As handed over: the engine goes on to change its own list.
      messages: structuredClone(messages),
    });
    if (scripts !== undefined) {
      recordToolResults(scripts, messages);
      scripts.prompts.push(promptOf(messages));
    }
    if (
      threadId === undefined ||
      runId === undefined ||
      scripts === undefined
    ) {
      yield* scriptedTurnChunks(
        { finishReason: "stop", text: SIDE_CALL_TEXT, type: "text" },
        {
          index: 0,
          model,
          runId: runId ?? "side-run",
          threadId: threadId ?? "side-thread",
        },
      );
      return;
    }
    let active = runs.get(runId);
    if (active === undefined) {
      const next = scripts.queue.shift();
      if (next === undefined) {
        scripts.unscriptedCalls.push(runId);
        throw new ScriptedProviderError({
          message: "The scripted provider has no run left for this thread",
        });
      }
      active = { index: 0, run: next };
      runs.set(runId, active);
    }
    // Read now: the engine keeps building on the arrays it hands over.
    scripts.promptLedger.record(
      promptBlocksOf({ messages, systemPrompts, tools }),
    );
    const index = active.index;
    active.index += 1;
    const turn = active.run.at(index);
    if (turn === undefined) {
      scripts.unscriptedCalls.push(`${runId}#${String(index)}`);
      throw new ScriptedProviderError({
        message: "The scripted run has no iteration left",
      });
    }
    if (turn.type === "stall") {
      scripts.onStall();
    }
    const produced = { signatures: [], toolCallIds: [] };
    scripts.produced.push(produced);
    yield* recordingProduced(
      scriptedTurnChunks(turn, {
        index,
        model,
        runId,
        // The engine hands the provider its run's signal on the request.
        signal: request?.signal ?? undefined,
        threadId,
      }),
      produced,
    );
  },
  structuredOutput: async ({ outputSchema }) => {
    await Promise.resolve();
    const data = mockStructuredData(outputSchema);
    return {
      data,
      rawText: JSON.stringify(data),
      usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
    };
  },
};

let registered = false;

/**
 * Serves every chat model call from scripts until `restore`. The mock-model
 * flag is the switch the model seam reads, so restoring it hands resolution
 * back to the configured providers.
 */
export const installScriptedProvider = () => {
  if (!registered) {
    registerTanStackMockTextAdapterFactory((modelId) => ({
      ...adapter,
      model: modelId,
    }));
    registered = true;
  }
  const previousMockAI = env.USE_MOCK_AI;
  // "force": the scripts answer even a request made with an organization key.
  env.USE_MOCK_AI = "force";
  const owned = new Set<string>();

  const scriptsOf = (threadId: string): ThreadScripts => {
    const existing = threads.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created = newThreadScripts();
    threads.set(threadId, created);
    owned.add(threadId);
    return created;
  };

  return {
    /** Queues the runs `threadId`'s next requests answer, one per request. */
    script: (threadId: string, ...scripted: readonly ScriptedRun[]) => {
      scriptsOf(threadId).queue.push(...scripted);
    },
    /** The prompts of `threadId`'s scripted model calls
     *  (`chat.provider.prefix-stable`). */
    promptLedgerOf: (threadId: string): PromptPrefixLedger =>
      scriptsOf(threadId).promptLedger,
    /** Resolves once `threadId`'s next request reaches a stalling turn. */
    stalled: async (threadId: string): Promise<void> => {
      await scriptsOf(threadId).stalled;
    },
    /** `threadId`'s findings since the last call, cleared on read, so the next
     *  step starts clean. */
    /** The provider options of `threadId`'s model calls so far. */
    modelOptionsOf: (threadId: string): readonly unknown[] =>
      scriptsOf(threadId).modelOptions,
    /** The prompt of each of `threadId`'s model calls so far, one entry per
     *  message. */
    promptsOf: (threadId: string): readonly (readonly string[])[] =>
      scriptsOf(threadId).prompts,
    /** `threadId`'s model calls since the last call, as handed to the
     *  provider, cleared on read. */
    takeRequests: (threadId: string): ProviderRequest[] =>
      scriptsOf(threadId).requests.splice(0),
    takeFindings: (threadId: string): ScriptedProviderFindings => {
      const scripts = scriptsOf(threadId);
      const unconsumedScripts = scripts.queue
        .splice(0)
        .map((run) => JSON.stringify(run));
      return {
        changedToolResults: scripts.changedToolResults.splice(0),
        unconsumedScripts,
        unscriptedCalls: scripts.unscriptedCalls.splice(0),
      };
    },
    restore: () => {
      env.USE_MOCK_AI = previousMockAI;
      for (const threadId of owned) {
        threads.delete(threadId);
      }
    },
  };
};
