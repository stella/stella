import { EventType, normalizeStreamChunk } from "@tanstack/ai";
import type { AdapterYieldChunk, StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  finishReasonOf,
  STRIPPED_CHUNK_KEYS,
  toolCallEndInputOf,
  toolCallEndOutputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type {
  PublicChunkOfType,
  PublicRunFinishedChunk,
  PublicStreamChunk,
  PublicToolCallEndChunk,
  PublicToolCallStartChunk,
} from "@/api/lib/chat/tanstack-chat-runtime";

type StrippedChunkType = keyof typeof STRIPPED_CHUNK_KEYS;

/**
 * The spec-shaped minimum for each event type the table covers. Total over the
 * table, so a new row cannot land without a chunk to probe it with.
 */
const PROBE_BASE = {
  RUN_FINISHED: {
    type: EventType.RUN_FINISHED,
    threadId: "probe-thread",
    runId: "probe-run",
  },
  RUN_ERROR: {
    type: EventType.RUN_ERROR,
    message: "probe-message",
    code: "probe-code",
  },
  TOOL_CALL_START: {
    type: EventType.TOOL_CALL_START,
    toolCallId: "probe-call",
    toolCallName: "spec_tool",
  },
  TOOL_CALL_END: {
    type: EventType.TOOL_CALL_END,
    toolCallId: "probe-call",
  },
  TEXT_MESSAGE_CONTENT: {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "probe-message-id",
    delta: "probe-delta",
  },
  TOOL_CALL_ARGS: {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "probe-call",
    delta: "probe-delta",
  },
} as const satisfies Record<StrippedChunkType, StreamChunk>;

/**
 * One value per key the table names. Shapes the engine inspects (`error`,
 * `finishReason`, `state`) carry a value it accepts, so normalization takes
 * the branch it takes in production.
 */
const PROBE_VALUES = {
  args: '{"probe":true}',
  content: "probe-content",
  error: { message: "probe-error", code: "probe-error-code" },
  finishReason: "stop",
  input: { probe: "input" },
  model: "probe-model",
  output: { probe: "output" },
  result: "probe-result",
  runId: "probe-run",
  state: "output-available",
  threadId: "probe-thread",
  toolName: "probe_tool",
} as const satisfies Record<string, unknown>;

/**
 * Of the keys the engine takes off a chunk, the ones it re-files under
 * `metadata.tanstack`. The rest are dropped: `error` folds into the spec
 * `message`/`code`, `result` leaves as a separate `TOOL_CALL_RESULT`,
 * `toolName` on a start event folds into `toolCallName`, and the two delta
 * events lose their trio outright.
 */
const MOVED_TO_METADATA = {
  RUN_FINISHED: ["finishReason", "model"],
  RUN_ERROR: ["finishReason", "model", "runId", "threadId"],
  TOOL_CALL_START: [],
  TOOL_CALL_END: ["input", "output", "state", "toolName"],
  TEXT_MESSAGE_CONTENT: [],
  TOOL_CALL_ARGS: [],
} as const satisfies Record<StrippedChunkType, readonly string[]>;

const strippedKeysOf = (chunkType: StrippedChunkType): readonly string[] =>
  STRIPPED_CHUNK_KEYS[chunkType];

// Enumerated so the loop below is typed by event; the first test pins it
// against the table's own keys, so a new row cannot go unprobed.
const strippedChunkTypes = [
  "RUN_FINISHED",
  "RUN_ERROR",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "TEXT_MESSAGE_CONTENT",
  "TOOL_CALL_ARGS",
] as const satisfies readonly StrippedChunkType[];

// `AdapterYieldChunk` is the pre-normalization shape the engine takes: a spec
// event plus every non-spec key an adapter may set. The keys go on by
// assignment because they are exactly the ones a spec event type does not
// declare, which is what the probe is for.
const probeChunkFor = (chunkType: StrippedChunkType): AdapterYieldChunk => {
  const probe: AdapterYieldChunk = { ...PROBE_BASE[chunkType] };
  for (const key of strippedKeysOf(chunkType)) {
    Object.assign(probe, { [key]: Reflect.get(PROBE_VALUES, key) });
  }
  return probe;
};

const isChunkOfType =
  <TType extends StrippedChunkType>(chunkType: TType) =>
  (chunk: PublicStreamChunk): chunk is PublicChunkOfType<TType> =>
    chunk.type === chunkType;

const normalizedProbe = <TType extends StrippedChunkType>(
  chunkType: TType,
): PublicChunkOfType<TType> => {
  // A `TOOL_CALL_END` carrying a `result` also yields a `TOOL_CALL_RESULT`;
  // the event under test is the one that kept its own type.
  const normalized = normalizeStreamChunk(probeChunkFor(chunkType)).find(
    isChunkOfType(chunkType),
  );
  if (normalized === undefined) {
    throw new Error(`normalizeStreamChunk dropped ${chunkType}`);
  }
  return normalized;
};

const tanstackMetadataOf = (chunk: object): Record<string, unknown> => {
  const metadata: unknown = Reflect.get(chunk, "metadata");
  const tanstack: unknown =
    typeof metadata === "object" && metadata !== null
      ? Reflect.get(metadata, "tanstack")
      : undefined;
  return typeof tanstack === "object" && tanstack !== null
    ? { ...tanstack }
    : {};
};

describe("engine-emitted chunk shape", () => {
  test("every key the table names has a probe value", () => {
    const unprobed = strippedChunkTypes
      .flatMap(strippedKeysOf)
      .filter((key) => !Object.hasOwn(PROBE_VALUES, key));
    expect(unprobed).toEqual([]);
  });

  test("every row of the table is probed", () => {
    expect(Object.keys(STRIPPED_CHUNK_KEYS).toSorted()).toEqual(
      [...strippedChunkTypes].toSorted(),
    );
  });

  for (const chunkType of strippedChunkTypes) {
    describe(chunkType, () => {
      test("loses exactly the keys the table names", () => {
        const source = probeChunkFor(chunkType);
        const normalized = normalizedProbe(chunkType);
        const removed = Object.keys(source).filter(
          (key) => !Object.hasOwn(normalized, key),
        );
        expect(removed.toSorted()).toEqual(
          [...strippedKeysOf(chunkType)].toSorted(),
        );
      });

      test("re-files exactly the moved keys under metadata.tanstack", () => {
        const normalized = normalizedProbe(chunkType);
        const tanstack = tanstackMetadataOf(normalized);
        const moved: readonly string[] = MOVED_TO_METADATA[chunkType];
        const stripped = strippedKeysOf(chunkType);
        expect(
          Object.keys(tanstack)
            .filter((key) => stripped.includes(key))
            .toSorted(),
        ).toEqual([...moved].toSorted());
        for (const key of moved) {
          expect(tanstack[key]).toEqual(Reflect.get(PROBE_VALUES, key));
        }
      });
    });
  }
});

describe("chunk readers", () => {
  test("read the finish reason from a normalized run and from a synthetic one", () => {
    expect(finishReasonOf(normalizedProbe("RUN_FINISHED"))).toBe("stop");

    const synthetic: PublicRunFinishedChunk = {
      type: EventType.RUN_FINISHED,
      threadId: "probe-thread",
      runId: "probe-run",
      metadata: { tanstack: { finishReason: "length" } },
    };
    expect(finishReasonOf(synthetic)).toBe("length");

    const reasonless: PublicRunFinishedChunk = {
      type: EventType.RUN_FINISHED,
      threadId: "probe-thread",
      runId: "probe-run",
    };
    expect(finishReasonOf(reasonless)).toBeNull();
  });

  test("read tool-call input, output, and name from a normalized end event", () => {
    const normalized = normalizedProbe("TOOL_CALL_END");
    expect(toolCallEndInputOf(normalized)).toEqual({ probe: "input" });
    expect(toolCallEndOutputOf(normalized)).toEqual({ probe: "output" });
    expect(toolCallNameOf(normalized)).toBe("probe_tool");
  });

  test("read the same fields off a chunk that never went through the engine", () => {
    const synthetic: PublicToolCallEndChunk = {
      type: EventType.TOOL_CALL_END,
      toolCallId: "probe-call",
      metadata: {},
    };
    Object.assign(synthetic, {
      input: { probe: "input" },
      output: { probe: "output" },
      toolName: "probe_tool",
    });
    expect(toolCallEndInputOf(synthetic)).toEqual({ probe: "input" });
    expect(toolCallEndOutputOf(synthetic)).toEqual({ probe: "output" });
    expect(toolCallNameOf(synthetic)).toBe("probe_tool");
  });

  test("prefer the spec tool name on a start event", () => {
    expect(toolCallNameOf(normalizedProbe("TOOL_CALL_START"))).toBe(
      "spec_tool",
    );
  });
});

// Each directive fails the typecheck if `PublicStreamChunk` stops hiding the
// key it names, which is the whole guard: the two production defects this
// module exists for were top-level reads that compiled.
const rejectedFinishReason = (chunk: PublicRunFinishedChunk): unknown =>
  // @ts-expect-error the engine moves `finishReason` into metadata.tanstack
  chunk.finishReason;

const rejectedRunErrorPayload = (
  chunk: Extract<PublicStreamChunk, { type: EventType.RUN_ERROR }>,
): unknown =>
  // @ts-expect-error the engine folds `error` into the spec message and code
  chunk.error;

const rejectedToolCallEndInput = (chunk: PublicToolCallEndChunk): unknown =>
  // @ts-expect-error the engine moves `input` into metadata.tanstack
  chunk.input;

const rejectedToolCallStartName = (chunk: PublicToolCallStartChunk): unknown =>
  // @ts-expect-error the engine folds `toolName` into `toolCallName`
  chunk.toolName;

test("engine-emitted chunks reject a top-level read of a moved key", () => {
  expect([
    rejectedFinishReason,
    rejectedRunErrorPayload,
    rejectedToolCallEndInput,
    rejectedToolCallStartName,
  ]).toHaveLength(4);
});
