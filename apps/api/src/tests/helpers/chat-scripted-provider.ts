import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk, AnyTextAdapter } from "@tanstack/ai";

import { mockStructuredData } from "@/api/dev/register-mock-ai";
import { env } from "@/api/env";
import { registerTanStackMockTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
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
  /** Provider calls for a scripted thread after its scripts ran out. */
  unscriptedCalls: string[];
  /** Scripts no request consumed. */
  unconsumedScripts: string[];
};

const SIDE_CALL_TEXT = "Scripted side answer";

type ThreadScripts = {
  /** The provider options of every model call the thread made, in order. */
  modelOptions: unknown[];
  /** Resolves the current `stalled` promise and arms the next one. */
  onStall: () => void;
  /** What each of the thread's model calls produced, in order. */
  produced: ProducedStep[];
  queue: ScriptedRun[];
  /** The model calls not yet taken by `takeRequests`, as handed to the
   *  provider. */
  requests: ProviderRequest[];
  /** Resolves once a request on the thread reaches a stalling turn. */
  stalled: Promise<undefined>;
  unscriptedCalls: string[];
};

const newThreadScripts = (): ThreadScripts => {
  const scripts: ThreadScripts = {
    modelOptions: [],
    onStall: () => undefined,
    produced: [],
    queue: [],
    requests: [],
    stalled: Promise.resolve(undefined),
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
    threadId,
  }) {
    const scripts = threadId === undefined ? undefined : threads.get(threadId);
    scripts?.modelOptions.push(modelOptions);
    scripts?.requests.push({
      earlierSteps: [...scripts.produced],
      format: "model-messages",
      // As handed over: the engine goes on to change its own list.
      messages: structuredClone(messages),
    });
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
