import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { getChatTurnDurationMs } from "@/components/chat/chat-turn-duration.logic";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

// How often subscribers hear about a streaming response: messages that change
// while a request runs reach them once per scheduled emit, however many
// chunks arrived; everything that ends or interrupts the run reaches them at
// once, with the latest messages.

const THREAD_ID = toChatThreadId("thread-emit");
const RUN_ID = "run-emit";
const ANSWER_ID = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "call-draft";
const BURST = 50;

const previousFetch = globalThis.fetch;
const encoder = new TextEncoder();

type ServerStream = {
  close: () => void;
  push: (...events: Record<string, unknown>[]) => void;
};

/** Answers the page's chat request with a stream the test writes to. */
const installStream = (): ServerStream => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      controller = streamController;
    },
  });
  globalThis.fetch = Object.assign(
    async () => {
      await Promise.resolve();
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    { preconnect: previousFetch.preconnect },
  );
  return {
    close: () => {
      controller?.close();
    },
    push: (...events) => {
      for (const event of events) {
        controller?.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
    },
  };
};

/** The emits the runtime asked for and has not cancelled, run by the test. */
type ManualScheduler = {
  pending: () => number;
  run: () => void;
  schedule: (callback: () => void) => () => void;
};

const createManualScheduler = (): ManualScheduler => {
  const callbacks = new Set<() => void>();
  return {
    pending: () => callbacks.size,
    run: () => {
      for (const scheduled of [...callbacks]) {
        callbacks.delete(scheduled);
        scheduled();
      }
    },
    schedule: (callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };
};

const tick = async (times = 20) => {
  for (let index = 0; index < times; index += 1) {
    await sleep(0);
  }
};

type Snapshot = ReturnType<ChatRuntime["getSnapshot"]>;

const WAIT_TICKS = 2000;

/** The client reads the stream a chunk per task: wait until it has read as
 *  far as the test needs. */
const waitFor = async (reached: () => boolean) => {
  for (let index = 0; index < WAIT_TICKS && !reached(); index += 1) {
    await tick(1);
  }
  expect(reached()).toBe(true);
};

type Page = {
  errors: Error[];
  /** Every snapshot a subscriber was told about, in order. */
  heard: Snapshot[];
  runtime: ChatRuntime;
  scheduler: ManualScheduler;
};

const openPage = (): Page => {
  const errors: Error[] = [];
  const heard: Snapshot[] = [];
  const scheduler = createManualScheduler();
  const runtime = createChatRuntime({
    activeTurnId: null,
    context: undefined,
    initialMessages: [],
    key: { scope: "global", threadId: THREAD_ID },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => {},
    reloadThread: () => {},
    scheduleEmit: scheduler.schedule,
  });
  runtime.subscribe(() => {
    heard.push(runtime.getSnapshot());
  });
  return { errors, heard, runtime, scheduler };
};

const send = async (page: Page) =>
  await Result.tryPromise(
    async () =>
      await sendThreadChatMessage(page.runtime, {
        content: "Draft the NDA",
        id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000001"),
      }),
  );

const RUN_STARTED = { runId: RUN_ID, threadId: THREAD_ID, type: "RUN_STARTED" };
const ANSWER_STARTED = {
  messageId: ANSWER_ID,
  role: "assistant",
  type: "TEXT_MESSAGE_START",
};

const textDeltas = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => ({
    delta: `${String(from + index)} `,
    messageId: ANSWER_ID,
    type: "TEXT_MESSAGE_CONTENT",
  }));

const expectedText = (count: number) =>
  Array.from({ length: count }, (_, index) => `${String(index)} `).join("");

const answerText = (snapshot: Snapshot | undefined): string => {
  const parts = snapshot?.messages.at(-1)?.parts ?? [];
  let text = "";
  for (const part of parts) {
    if (part.type === "text") {
      text += part.content;
    }
  }
  return text;
};

/** What subscribers heard after `from` emits, up to the first emit that
 *  matches. */
const firstHeard = (
  page: Page,
  from: number,
  matches: (snapshot: Snapshot) => boolean,
): Snapshot | undefined => page.heard.slice(from).find(matches);

/** A page whose request streams, with every earlier emit already heard. */
const openStreamingPage = async () => {
  const server = installStream();
  const page = openPage();
  const sent = send(page);
  await tick();
  server.push(RUN_STARTED, ANSWER_STARTED);
  await tick();
  page.scheduler.run();
  return { page, server, sent };
};

describe("chat runtime emits while a response streams", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("anchors timing when received before a deferred render and preserves it across snapshots", async () => {
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const server = installStream();
    const page = openPage();
    const sent = send(page);
    await tick();
    const timing = {
      status: "running",
      durationMs: 4000,
      elapsedMs: 1000,
      startedAt: "2026-01-01T00:00:00.000Z",
      observedAt: "2026-01-01T00:00:01.000Z",
    } as const;
    server.push(RUN_STARTED, {
      ...ANSWER_STARTED,
      metadata: { turnTiming: timing },
    });
    await waitFor(
      () =>
        page.runtime.getSnapshot().messages.at(-1)?.metadata?.turnTiming
          ?.status === "running",
    );
    now = 1100;
    const received = page.runtime.getSnapshot().messages.at(-1)
      ?.metadata?.turnTiming;
    if (received === undefined || received === null) {
      panic("Expected streamed turn timing");
    }
    expect(getChatTurnDurationMs(received, now)).toBe(6000);
    // The SDK receives another object from the same server timing read.
    server.push({ ...ANSWER_STARTED, metadata: { turnTiming: timing } });
    await tick();
    now = 2100;
    page.scheduler.run();
    const repeated = page.runtime.getSnapshot().messages.at(-1)
      ?.metadata?.turnTiming;
    if (repeated === undefined || repeated === null) {
      panic("Expected repeated turn timing");
    }
    expect(getChatTurnDurationMs(repeated, now)).toBe(7000);
    server.push({
      type: "TEXT_MESSAGE_END",
      messageId: ANSWER_ID,
      metadata: { turnTiming: { status: "finished", durationMs: 7000 } },
    });
    await waitFor(
      () =>
        page.runtime.getSnapshot().messages.at(-1)?.metadata?.turnTiming
          ?.status === "finished",
    );
    now = 100_000;
    const finished = page.runtime.getSnapshot().messages.at(-1)
      ?.metadata?.turnTiming;
    if (finished === undefined || finished === null) {
      panic("Expected settled turn timing");
    }
    expect(getChatTurnDurationMs(finished, now)).toBe(7000);
    server.close();
    expect(await sent).toEqual(Result.ok(undefined));
    clock.mockRestore();
  });

  test("tells subscribers once about a burst of chunks", async () => {
    const { page, server, sent } = await openStreamingPage();
    const heardBefore = page.heard.length;

    server.push(...textDeltas(BURST));
    await waitFor(
      () => answerText(page.runtime.getSnapshot()) === expectedText(BURST),
    );

    // Nothing heard yet, one emit asked for, and imperative readers already
    // see every chunk.
    expect(page.heard).toHaveLength(heardBefore);
    expect(page.scheduler.pending()).toBe(1);
    expect(answerText(page.runtime.getSnapshot())).toBe(expectedText(BURST));

    page.scheduler.run();
    expect(page.heard).toHaveLength(heardBefore + 1);
    expect(answerText(page.heard.at(-1))).toBe(expectedText(BURST));
    expect(page.scheduler.pending()).toBe(0);
    server.close();
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("delivers the finished answer with the end of the run", async () => {
    const { page, server, sent } = await openStreamingPage();
    const heardBefore = page.heard.length;

    server.push(
      ...textDeltas(BURST),
      { messageId: ANSWER_ID, type: "TEXT_MESSAGE_END" },
      {
        finishReason: "stop",
        runId: RUN_ID,
        threadId: THREAD_ID,
        type: "RUN_FINISHED",
      },
    );
    server.close();
    await waitFor(() => !page.runtime.getSnapshot().isLoading);

    // The scheduled emit never ran: the end of the run carried the messages.
    const ended = firstHeard(
      page,
      heardBefore,
      (snapshot) => !snapshot.isLoading,
    );
    expect(ended).toBeDefined();
    expect(answerText(ended)).toBe(expectedText(BURST));
    expect(page.scheduler.pending()).toBe(0);
    expect(page.errors).toEqual([]);
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("delivers the chunks before an error with the error", async () => {
    const { page, server, sent } = await openStreamingPage();
    const heardBefore = page.heard.length;

    server.push(...textDeltas(BURST), {
      message: "The provider failed",
      runId: RUN_ID,
      threadId: THREAD_ID,
      type: "RUN_ERROR",
    });
    server.close();
    await waitFor(() => page.runtime.getSnapshot().error !== undefined);

    const failed = firstHeard(
      page,
      heardBefore,
      (snapshot) => snapshot.error !== undefined,
    );
    expect(failed).toBeDefined();
    expect(answerText(failed)).toBe(expectedText(BURST));
    expect(page.errors).toHaveLength(1);
    expect(await sent).toEqual(Result.ok(undefined));
    expect(page.errors.at(0)?.message).toBe("The provider failed");
  });

  test("delivers a client call's whole input when the run pauses for it", async () => {
    const { page, server, sent } = await openStreamingPage();
    const input = { name: "NDA", source: "@title NDA ".repeat(BURST) };
    const serialized = JSON.stringify(input);
    const argumentDeltas = Array.from(
      { length: Math.ceil(serialized.length / 8) },
      (_, index) => ({
        delta: serialized.slice(index * 8, index * 8 + 8),
        toolCallId: CALL_ID,
        type: "TOOL_CALL_ARGS",
      }),
    );
    // More deltas than the threshold the canary allows in a second.
    expect(argumentDeltas.length).toBeGreaterThan(BURST);
    const heardBefore = page.heard.length;

    server.push(
      {
        parentMessageId: ANSWER_ID,
        toolCallId: CALL_ID,
        toolCallName: "create-document",
        toolName: "create-document",
        type: "TOOL_CALL_START",
      },
      ...argumentDeltas,
      {
        input,
        toolCallId: CALL_ID,
        toolCallName: "create-document",
        toolName: "create-document",
        type: "TOOL_CALL_END",
      },
      {
        finishReason: "tool_calls",
        runId: RUN_ID,
        threadId: THREAD_ID,
        type: "RUN_FINISHED",
      },
    );
    server.close();
    await waitFor(() => !page.runtime.getSnapshot().isLoading);

    const paused = firstHeard(
      page,
      heardBefore,
      (snapshot) => !snapshot.isLoading,
    );
    expect(paused?.messages.at(-1)?.parts).toMatchObject([
      { arguments: serialized, id: CALL_ID, type: "tool-call" },
    ]);
    // Far fewer emits than deltas, none of them from the scheduler.
    expect(page.heard.length - heardBefore).toBeLessThan(10);
    expect(await sent).toEqual(Result.ok(undefined));
  });
});
