import { EventType } from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import type { CALL_ID_CARRIER } from "@/api/lib/chat/unique-tool-call-ids";
import { withUniqueToolCallIds } from "@/api/lib/chat/unique-tool-call-ids";

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
): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = [];
  for await (const chunk of withUniqueToolCallIds(streamOf(chunks), history)) {
    out.push(chunk);
  }
  return out;
};

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
          const seen = new Set(historyIds);
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
