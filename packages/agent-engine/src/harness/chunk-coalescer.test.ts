import {
  EventType,
  type StreamChunk,
  StreamProcessor,
  type UIMessage,
} from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  CHUNK_COALESCE_WINDOW_MS,
  type CoalesceSchedule,
  createChunkCoalescer,
} from "./chunk-coalescer";
import type { HarnessEvent, HarnessToolCall } from "./events";
import { harnessEventsToChunks } from "./stream-chunks";

/** Timers on a clock only the test moves. */
const manualTimers = () => {
  const state = { now: 0 };
  const pending: { at: number; flush: () => void; live: boolean }[] = [];
  const schedule: CoalesceSchedule = (flush, delayMs) => {
    const timer = { at: state.now + delayMs, flush, live: true };
    pending.push(timer);
    return () => {
      timer.live = false;
    };
  };
  const advance = (ms: number) => {
    state.now += ms;
    for (const timer of pending.splice(0)) {
      if (!timer.live) {
        continue;
      }
      if (timer.at <= state.now) {
        timer.flush();
      } else {
        pending.push(timer);
      }
    }
  };
  return { schedule, advance };
};

const coalesced = (options?: { maxDeltaBytes?: number }) => {
  const timers = manualTimers();
  const sent: StreamChunk[] = [];
  const coalescer = createChunkCoalescer({
    emit: (chunk) => {
      sent.push(chunk);
    },
    schedule: timers.schedule,
    ...options,
  });
  return { coalescer, sent, advance: timers.advance };
};

const text = (messageId: string, delta: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta,
  timestamp: 0,
});

const reasoning = (messageId: string, delta: string): StreamChunk => ({
  type: EventType.REASONING_MESSAGE_CONTENT,
  messageId,
  delta,
  timestamp: 0,
});

const deltasOf = (chunks: readonly StreamChunk[]) =>
  chunks.map((chunk) =>
    chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
    chunk.type === EventType.REASONING_MESSAGE_CONTENT
      ? chunk.delta
      : chunk.type,
  );

/** Fold chunks the way persistence does and return what would be stored. */
const stored = (chunks: readonly StreamChunk[]) => {
  const processor = new StreamProcessor({ initialMessages: [] });
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  return processor
    .getMessages()
    .map(({ role, parts }: UIMessage) => ({ role, parts }));
};

type ContentChunk = Extract<
  StreamChunk,
  { type: EventType.TEXT_MESSAGE_CONTENT | EventType.REASONING_MESSAGE_CONTENT }
>;

const isContent = (chunk: StreamChunk): chunk is ContentChunk =>
  chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
  chunk.type === EventType.REASONING_MESSAGE_CONTENT;

const utf8Length = (value: string) =>
  new TextEncoder().encode(value).byteLength;

describe("streamed delta coalescing", () => {
  test("deltas inside the window go out as one chunk once the window ends", () => {
    const { coalescer, sent, advance } = coalesced();
    coalescer.push(text("m1", "The "));
    advance(50);
    coalescer.push(text("m1", "matter "));
    advance(50);
    coalescer.push(text("m1", "holds"));
    advance(CHUNK_COALESCE_WINDOW_MS - 101);
    expect(sent).toEqual([]);
    advance(1);
    expect(sent).toEqual([text("m1", "The matter holds")]);
    coalescer.push(text("m1", " one brief."));
    advance(CHUNK_COALESCE_WINDOW_MS);
    expect(deltasOf(sent)).toEqual(["The matter holds", " one brief."]);
  });

  test("any other chunk sends what is held first, and passes unchanged", () => {
    const { coalescer, sent } = coalesced();
    const end: StreamChunk = {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m1",
      timestamp: 0,
    };
    coalescer.push(text("m1", "Found"));
    coalescer.push(text("m1", " two"));
    coalescer.push(end);
    expect(sent).toEqual([text("m1", "Found two"), end]);
  });

  test("deltas of another message or kind are never merged", () => {
    const { coalescer, sent } = coalesced();
    coalescer.push(text("m1", "a"));
    coalescer.push(text("m2", "b"));
    coalescer.push(reasoning("m2", "c"));
    coalescer.push(reasoning("m2", "d"));
    coalescer.flush();
    expect(sent).toEqual([
      text("m1", "a"),
      text("m2", "b"),
      reasoning("m2", "cd"),
    ]);
  });

  test("a merged chunk stays within the byte bound; a larger single delta passes alone", () => {
    const { coalescer, sent } = coalesced({ maxDeltaBytes: 8 });
    // Four bytes each in UTF-8, so the bound counts bytes, not characters.
    coalescer.push(text("m1", "čč"));
    coalescer.push(text("m1", "čč"));
    expect(deltasOf(sent)).toEqual(["čččč"]);
    coalescer.push(text("m1", "abc"));
    coalescer.push(text("m1", "abcdefghij"));
    coalescer.push(text("m1", "x"));
    coalescer.flush();
    expect(deltasOf(sent)).toEqual(["čččč", "abc", "abcdefghij", "x"]);
  });

  test("the stream's end sends what is held, and a later timer sends nothing twice", () => {
    const { coalescer, sent, advance } = coalesced();
    coalescer.push(text("m1", "last words"));
    coalescer.flush();
    advance(CHUNK_COALESCE_WINDOW_MS);
    coalescer.flush();
    expect(sent).toEqual([text("m1", "last words")]);
  });

  test("streamed reasoning folds to the same stored reasoning", () => {
    const open: StreamChunk[] = [
      { type: EventType.RUN_STARTED, runId: "r", threadId: "t", timestamp: 0 },
      { type: EventType.REASONING_START, messageId: "r1", timestamp: 0 },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "r1",
        role: "reasoning",
        timestamp: 0,
      },
    ];
    const close: StreamChunk[] = [
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1", timestamp: 0 },
      { type: EventType.REASONING_END, messageId: "r1", timestamp: 0 },
      {
        type: EventType.RUN_FINISHED,
        runId: "r",
        threadId: "t",
        timestamp: 0,
      },
    ];
    const streamed = [
      ...open,
      ...["Searching ", "the ", "matter."].map((delta) =>
        reasoning("r1", delta),
      ),
      ...close,
    ];
    const { coalescer, sent } = coalesced();
    for (const chunk of streamed) {
      coalescer.push(chunk);
    }
    expect(sent.filter(isContent)).toHaveLength(1);
    expect(stored(sent)).toEqual(stored(streamed));
    expect(JSON.stringify(stored(sent))).toContain("Searching the matter.");
  });
});

describe("coalescing invariants", () => {
  const toolCall: HarnessToolCall = {
    id: "call-a",
    name: "command_execution",
    input: { command: "ls" },
  };
  const step: fc.Arbitrary<HarnessEvent> = fc.oneof(
    {
      weight: 6,
      arbitrary: fc
        .tuple(fc.constantFrom("m1", "m2"), fc.string({ maxLength: 12 }))
        .map(([messageId, delta]) => ({
          type: "text.delta" as const,
          messageId,
          delta,
        })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom("m1", "m2"), fc.string({ maxLength: 12 }))
        .map(([messageId, full]) => ({
          type: "text.completed" as const,
          messageId,
          text: full,
        })),
    },
    {
      weight: 1,
      arbitrary: fc.constant<HarnessEvent>({
        type: "reasoning.completed",
        messageId: "r1",
        text: "Thinking.",
      }),
    },
    {
      weight: 1,
      arbitrary: fc.constant<HarnessEvent>({ type: "tool.started", toolCall }),
    },
    {
      weight: 1,
      arbitrary: fc.constant<HarnessEvent>({
        type: "tool.completed",
        toolCall,
        result: { content: "notes.md", status: "succeeded" },
      }),
    },
  );

  const streamedChunks = async (events: readonly HarnessEvent[]) => {
    const chunks: StreamChunk[] = [];
    let generated = 0;
    const source = (async function* () {
      yield* events;
      yield { type: "turn.completed" as const, usage: null };
    })();
    for await (const chunk of harnessEventsToChunks(source, {
      harness: "codex",
      model: "gpt-test",
      runId: "run-1",
      threadId: "thread-1",
      generateId: () => {
        generated += 1;
        return `id-${String(generated)}`;
      },
      now: () => 0,
    })) {
      chunks.push(chunk);
    }
    return chunks;
  };

  test("whatever the timing, the coalesced stream stores the same message, keeps every other chunk in order and stays within its bound", async () => {
    await assertProperty(
      "whatever the timing, the coalesced stream stores the same message, keeps every other chunk in order and stays within its bound",
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 0, max: 2 * CHUNK_COALESCE_WINDOW_MS }), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.integer({ min: 1, max: 24 }),
        async (events, gaps, maxDeltaBytes) => {
          const streamed = await streamedChunks(events);
          const { coalescer, sent, advance } = coalesced({ maxDeltaBytes });
          for (const [index, chunk] of streamed.entries()) {
            coalescer.push(chunk);
            advance(gaps[index % gaps.length] ?? 0);
          }
          coalescer.flush();

          expect(stored(sent)).toEqual(stored(streamed));
          expect(sent.filter((chunk) => !isContent(chunk))).toEqual(
            streamed.filter((chunk) => !isContent(chunk)),
          );
          expect(sent.length).toBeLessThanOrEqual(streamed.length);
          const single = new Set(
            streamed.filter(isContent).map((chunk) => JSON.stringify(chunk)),
          );
          for (const chunk of sent.filter(isContent)) {
            if (!single.has(JSON.stringify(chunk))) {
              expect(utf8Length(chunk.delta)).toBeLessThanOrEqual(
                maxDeltaBytes,
              );
            }
          }
        },
      ),
    );
  });

  test("a long streamed answer becomes a bounded number of messages", async () => {
    // Four thousand deltas 30 ms apart: two minutes of streaming.
    const events: HarnessEvent[] = Array.from({ length: 4000 }, (_, index) => ({
      type: "text.delta",
      messageId: "m1",
      delta: `word${String(index)} `,
    }));
    const streamed = await streamedChunks(events);
    const { coalescer, sent, advance } = coalesced();
    for (const chunk of streamed) {
      coalescer.push(chunk);
      advance(30);
    }
    coalescer.flush();
    const sentDeltas = sent.filter(isContent).length;
    expect(streamed.filter(isContent)).toHaveLength(4000);
    expect(sentDeltas).toBeLessThanOrEqual(
      Math.ceil((4000 * 30) / CHUNK_COALESCE_WINDOW_MS) + 1,
    );
    expect(stored(sent)).toEqual(stored(streamed));
  });
});
