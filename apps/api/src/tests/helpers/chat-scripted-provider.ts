import type { AnyTextAdapter, ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";

import { stableStringify } from "@stll/stable-stringify";

import { mockStructuredData } from "@/api/dev/register-mock-ai";
import { env } from "@/api/env";
import { toJsonValue } from "@/api/lib/json-value";
import { registerTanStackMockTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import {
  ScriptedProviderError,
  scriptedAdapterBase,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";

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
  /** Tool calls a model call was handed without their result. */
  unsettledCalls: unknown[];
};

const SIDE_CALL_TEXT = "Scripted side answer";

type ThreadScripts = {
  /** See `ScriptedProviderFindings`. */
  changedToolResults: unknown[];
  /** The provider options of every model call the thread made, in order. */
  modelOptions: unknown[];
  /** Resolves the current `stalled` promise and arms the next one. */
  onStall: () => void;
  /** The prompt of every model call the thread made, in order. */
  prompts: string[][];
  queue: ScriptedRun[];
  /** Resolves once a request on the thread reaches a stalling turn. */
  stalled: Promise<undefined>;
  /** Per tool call id: the result the first model call that held one was
   *  handed. */
  toolResults: Map<string, string>;
  unscriptedCalls: string[];
  /** See `ScriptedProviderFindings`. */
  unsettledCalls: unknown[];
};

const newThreadScripts = (): ThreadScripts => {
  const scripts: ThreadScripts = {
    changedToolResults: [],
    modelOptions: [],
    onStall: () => undefined,
    prompts: [],
    queue: [],
    stalled: Promise.resolve(undefined),
    toolResults: new Map(),
    unscriptedCalls: [],
    unsettledCalls: [],
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
 * A tool result's content, its JSON in canonical key order: storing a result
 * reorders its keys (jsonb), which does not change what it says.
 */
const resultIdentity = (content: ModelMessage["content"]): string => {
  if (typeof content !== "string") {
    return stableStringify(toJsonValue(content));
  }
  const parsed = Result.try((): unknown => JSON.parse(content));
  return Result.isOk(parsed)
    ? stableStringify(toJsonValue(parsed.value))
    : stableStringify(content);
};

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
 * Each tool call `messages` hands the model whose result does not follow it
 * before the next message of another role: a provider refuses a request that
 * leaves a call unanswered, so every call the thread stored, failed ones
 * included, must reach the model paired with its result.
 */
const findUnsettledCalls = (messages: readonly ModelMessage[]): unknown[] =>
  messages.flatMap((message, at) => {
    if (message.role !== "assistant") {
      return [];
    }
    const answered = new Set<string>();
    for (const next of messages.slice(at + 1)) {
      if (next.role !== "tool") {
        break;
      }
      if (next.toolCallId !== undefined) {
        answered.add(next.toolCallId);
      }
    }
    return (message.toolCalls ?? []).flatMap((call) =>
      answered.has(call.id)
        ? []
        : [{ name: call.function.name, toolCallId: call.id }],
    );
  });

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

const adapter: AnyTextAdapter = {
  ...scriptedAdapterBase,
  async *chatStream({
    messages,
    model,
    modelOptions,
    request,
    runId,
    threadId,
  }) {
    const scripts = threadId === undefined ? undefined : threads.get(threadId);
    scripts?.modelOptions.push(modelOptions);
    if (scripts !== undefined) {
      recordToolResults(scripts, messages);
      scripts.prompts.push(promptOf(messages));
      scripts.unsettledCalls.push(...findUnsettledCalls(messages));
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
    yield* scriptedTurnChunks(turn, {
      index,
      model,
      runId,
      // The engine hands the provider its run's signal on the request.
      signal: request?.signal ?? undefined,
      threadId,
    });
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
    registerTanStackMockTextAdapterFactory(() => adapter);
    registered = true;
  }
  const previousMockAI = env.USE_MOCK_AI;
  env.USE_MOCK_AI = true;
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
    takeFindings: (threadId: string): ScriptedProviderFindings => {
      const scripts = scriptsOf(threadId);
      const unconsumedScripts = scripts.queue
        .splice(0)
        .map((run) => JSON.stringify(run));
      return {
        changedToolResults: scripts.changedToolResults.splice(0),
        unconsumedScripts,
        unscriptedCalls: scripts.unscriptedCalls.splice(0),
        unsettledCalls: scripts.unsettledCalls.splice(0),
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
