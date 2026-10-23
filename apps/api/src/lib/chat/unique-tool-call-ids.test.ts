import { chat, EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ChatMiddleware,
  ModelMessage,
  StreamChunk,
} from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { arrayOrEmpty } from "@/api/lib/array";
import {
  withProviderStreamContract,
  withRunToolCallIds,
} from "@/api/lib/chat/provider-stream-contract";
import type { CALL_ID_CARRIER } from "@/api/lib/chat/unique-tool-call-ids";
import {
  ToolCallIdLedger,
  withUniqueToolCallIds,
} from "@/api/lib/chat/unique-tool-call-ids";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Few ids, so responses reuse the thread's ids and their own, as providers
// that number calls per response do; `call_0_2` is the first fresh id a
// reused `call_0` gets, so a provider id may also collide with a fresh one.
const ID = fc.constantFrom("call_0", "call_1", "call_2", "call_0_2");

const streamOf = async function* (
  chunks: readonly StreamChunk[],
): AsyncIterable<StreamChunk> {
  await Promise.resolve();
  yield* chunks;
};

const collect = async (
  chunks: readonly StreamChunk[],
  history: readonly ModelMessage[],
  ledger?: ToolCallIdLedger,
): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = [];
  for await (const chunk of withUniqueToolCallIds(streamOf(chunks), {
    ledger,
    messages: history,
  })) {
    out.push(chunk);
  }
  return out;
};

const startedIdsOf = (out: readonly StreamChunk[]): string[] =>
  out.flatMap((chunk) =>
    chunk.type === EventType.TOOL_CALL_START ? [chunk.toolCallId] : [],
  );

/** One call as an adapter streams it: start, arguments, end, and (for a
 *  server tool the adapter ran) its result. */
const callChunks = (id: string, withResult: boolean): StreamChunk[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: "lookup",
    timestamp: 1,
  },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}", timestamp: 1 },
  { type: EventType.TOOL_CALL_END, toolCallId: id, timestamp: 1 },
  ...(withResult
    ? [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "message",
          toolCallId: id,
          content: "{}",
          timestamp: 1,
        } satisfies StreamChunk,
      ]
    : []),
];

/** A stored turn holding `ids` as calls, each answered by its result. */
const turnOf = (ids: readonly string[]): ModelMessage[] => [
  {
    content: null,
    role: "assistant",
    toolCalls: ids.map((id) => ({
      function: { arguments: "{}", name: "lookup" },
      id,
      type: "function",
    })),
  },
  ...ids.map((id): ModelMessage => ({
    content: "{}",
    role: "tool",
    toolCallId: id,
  })),
];

const callIdOf = (chunk: StreamChunk): string | undefined =>
  chunk.type === EventType.TOOL_CALL_START ||
  chunk.type === EventType.TOOL_CALL_ARGS ||
  chunk.type === EventType.TOOL_CALL_END ||
  chunk.type === EventType.TOOL_CALL_RESULT
    ? chunk.toolCallId
    : undefined;

describe("tool call ids from a provider", () => {
  test("are unique within the thread, and each call keeps its chunks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(ID, { maxLength: 3 }),
        fc.array(fc.tuple(ID, fc.boolean()), { maxLength: 6 }),
        async (historyIds, calls) => {
          const out = await collect(
            calls.flatMap(([id, withResult]) => callChunks(id, withResult)),
            turnOf(historyIds),
          );
          const started = out.flatMap((chunk) =>
            chunk.type === EventType.TOOL_CALL_START ? [chunk.toolCallId] : [],
          );
          // Every call reaches the engine under an id the thread holds once.
          expect(new Set([...historyIds, ...started]).size).toBe(
            historyIds.length + started.length,
          );
          // Each call's arguments, end and result name the id it started with.
          let at = 0;
          for (const [index, [, withResult]] of calls.entries()) {
            const own = out.slice(at, at + (withResult ? 4 : 3));
            at += own.length;
            expect(own.map(callIdOf)).toEqual(own.map(() => started[index]));
          }
          expect(at).toBe(out.length);
          // An id the thread did not hold yet reaches the engine as sent.
          // Renamed ids widen the set beyond the generated alphabet.
          const seen = new Set<string>(historyIds);
          for (const [index, [id]] of calls.entries()) {
            if (!seen.has(id)) {
              expect(started[index]).toBe(id);
            }
            seen.add(id);
            seen.add(started[index] ?? id);
          }
        },
      ),
      propertyConfig({ numRuns: 200, seed: propertySeed() }),
    );
  });

  test("are unique within the thread when its earlier turns are outside the request", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Each thread id sits either in the request's history or only in the
        // thread (a turn the send window or compaction left out).
        fc.uniqueArray(fc.tuple(ID, fc.boolean()), {
          maxLength: 4,
          selector: ([id]) => id,
        }),
        fc.array(ID, { maxLength: 6 }),
        async (threadIds, calls) => {
          const inHistory = threadIds.flatMap(([id, carried]) =>
            carried ? [id] : [],
          );
          const out = await collect(
            calls.flatMap((id) => callChunks(id, false)),
            turnOf(inHistory),
            new ToolCallIdLedger(threadIds.map(([id]) => id)),
          );
          const started = startedIdsOf(out);
          expect(
            new Set([...threadIds.map(([id]) => id), ...started]).size,
          ).toBe(threadIds.length + started.length);
        },
      ),
      propertyConfig({ numRuns: 200, seed: propertySeed() }),
    );
  });

  test("a run's later request keeps the run's earlier calls taken", async () => {
    const ledger = new ToolCallIdLedger([]);
    const first = await collect(callChunks("call_0", true), [], ledger);
    // Compaction inside the run dropped the first call from this history.
    const second = await collect(callChunks("call_0", true), [], ledger);

    expect(startedIdsOf(first)).toEqual(["call_0"]);
    expect(startedIdsOf(second)).toEqual(["call_0_2"]);
  });

  test("a custom event naming a renamed call follows it", async () => {
    const out = await collect(
      [
        ...callChunks("call_0", false),
        {
          type: EventType.CUSTOM,
          name: "tool-input-available",
          value: { toolCallId: "call_0", toolName: "lookup" },
          timestamp: 1,
        },
      ],
      turnOf(["call_0"]),
    );

    expect(out.at(-1)).toMatchObject({ value: { toolCallId: "call_0_2" } });
  });

  test("every chunk with a top-level call id is renamed where it names one", () => {
    type TopLevel = `${Extract<StreamChunk, { toolCallId: string }>["type"]}`;
    type Covered = {
      [K in keyof typeof CALL_ID_CARRIER]: (typeof CALL_ID_CARRIER)[K] extends
        | "names"
        | "starts"
        ? K
        : never;
    }[keyof typeof CALL_ID_CARRIER];
    // Fails to compile when a chunk type gains a top-level `toolCallId`
    // without being renamed there.
    const uncovered: [Exclude<TopLevel, Covered>] extends [never]
      ? "none"
      : Exclude<TopLevel, Covered> = "none";

    expect(uncovered).toBe("none");
  });
});

/**
 * A provider that numbers calls per response: it calls `lookup` as `call_0`
 * on each of its first two turns, then answers.
 */
const perResponseNumberingAdapter = (): AnyTextAdapter => {
  let turn = 0;
  return asTestRaw<AnyTextAdapter>({
    kind: "text",
    model: "model",
    name: "fixture",
    label: () => "fixture",
    async *chatStream({ model }: { model: string }) {
      await Promise.resolve();
      turn += 1;
      const timestamp = 1;
      yield {
        type: EventType.RUN_STARTED,
        runId: "run",
        threadId: "thread",
        timestamp,
      };
      if (turn <= 2) {
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call_0",
          toolCallName: "lookup",
          timestamp,
        };
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call_0",
          delta: "{}",
          timestamp,
        };
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: "call_0",
          timestamp,
        };
      } else {
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "answer",
          role: "assistant",
          timestamp,
        };
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "answer",
          delta: "Done.",
          timestamp,
        };
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "answer",
          timestamp,
        };
      }
      yield {
        type: EventType.RUN_FINISHED,
        runId: "run",
        threadId: "thread",
        finishReason: turn <= 2 ? "tool_calls" : "stop",
        model,
        timestamp,
      };
    },
  });
};

/** Compaction inside the run: every earlier call leaves the history. */
const dropEarlierCalls: ChatMiddleware = {
  name: "drop-earlier-calls",
  onConfig: (ctx, config) =>
    ctx.phase === "beforeModel"
      ? {
          messages: config.messages.filter(
            (message) =>
              message.role !== "tool" &&
              arrayOrEmpty(message.toolCalls).length === 0,
          ),
        }
      : undefined,
};

const startedIdsInRun = async (ledger?: ToolCallIdLedger) => {
  const lookup = toolDefinition({
    name: "lookup",
    description: "Looks something up",
    inputSchema: toTanStackToolSchema(v.object({})),
  }).server(async () => "found");
  const adapter = withProviderStreamContract(perResponseNumberingAdapter());
  const started: string[] = [];
  for await (const chunk of chat({
    adapter:
      ledger === undefined ? adapter : withRunToolCallIds(adapter, ledger),
    agentLoopStrategy: maxIterations(4),
    messages: [{ role: "user", content: "Look it up twice." }],
    middleware: [dropEarlierCalls],
    tools: [lookup],
  })) {
    if (chunk.type === EventType.TOOL_CALL_START) {
      started.push(chunk.toolCallId);
    }
  }
  return started;
};

describe("tool call ids through the engine", () => {
  // Canary for one adapter serving every request of a run, compaction's
  // included: were the engine to stop reading the run's adapter, the second
  // call would reuse the first one's id.
  test("stay unique across a run whose history loses its earlier calls", async () => {
    // The fixture must express the fault: without the run's ledger the
    // second call reuses the first one's id.
    expect(await startedIdsInRun()).toEqual(["call_0", "call_0"]);

    expect(await startedIdsInRun(new ToolCallIdLedger([]))).toEqual([
      "call_0",
      "call_0_2",
    ]);
  });
});
