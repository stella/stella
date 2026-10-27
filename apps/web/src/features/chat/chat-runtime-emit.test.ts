import { panic, Result } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { getChatTurnDurationMs } from "@stll/api-contract/chat-turn-duration";
import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import { sleep } from "@stll/concurrency/sleep";

import { getChatAssistantTurnError } from "@/components/chat/chat-ui-tools";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import type { ChatThreadOptionsContext } from "@/features/chat/chat-query-contract";
import { findChatRequestError } from "@/features/chat/chat-request-error";
import {
  createChatRuntime,
  isChatMessageStartError,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { chatRefusal } from "@/lib/errors/api";
import { providerDiagnosticFromThrown } from "@/lib/errors/provider-diagnostic";
import { toSafeId } from "@/lib/safe-id";

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

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

const openPage = (context?: ChatThreadOptionsContext): Page => {
  const errors: Error[] = [];
  const heard: Snapshot[] = [];
  const scheduler = createManualScheduler();
  const runtime = createChatRuntime({
    activeTurnId: null,
    context,
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

  test("the real SDK keeps a refused first send's HTTP status and code in visible state", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            code: "validation_error",
            message: "Private parser details",
          }),
          {
            status: 422,
            headers: { "Content-Type": "application/json" },
          },
        ),
      { preconnect: previousFetch.preconnect },
    );
    const page = openPage();
    await send(page);

    expect(page.runtime.getSnapshot().status).toBe("error");
    expect(chatRefusal(page.runtime.getSnapshot().error)).toMatchObject({
      status: 422,
      code: "validation_error",
    });
    expect(chatRefusal(page.errors.at(0))).toMatchObject({
      status: 422,
      code: "validation_error",
    });
  });

  test("reports the original SDK rejection before append instead of a busy error", async () => {
    const failure = new TypeError("Message content could not be read");
    const page = openPage();
    const outcome = await Result.tryPromise({
      try: async () =>
        await sendThreadChatMessage(page.runtime, {
          get content(): string {
            throw failure;
          },
          id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000001"),
        }),
      catch: (error) => error,
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(findChatRequestError(outcome.error)?.kind).toBe(
        "preparation_failed",
      );
      expect(findChatRequestError(outcome.error)?.cause).toBe(failure);
    }
    expect(page.runtime.getSnapshot().messages).toEqual([]);
    expect(findChatRequestError(page.runtime.getSnapshot().error)?.cause).toBe(
      failure,
    );
  });

  test("preserves the original preparation rejection during a route handoff", async () => {
    const failure = new TypeError("Message content could not be read");
    const page = openPage();
    const outcome = await Result.tryPromise({
      try: async () =>
        await page.runtime.startRouteHandoffMessage({
          get content(): string {
            throw failure;
          },
          id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000001"),
        }),
      catch: (error) => error,
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(findChatRequestError(outcome.error)?.kind).toBe(
        "preparation_failed",
      );
      expect(findChatRequestError(outcome.error)?.cause).toBe(failure);
    }
    expect(page.runtime.getSnapshot().messages).toEqual([]);
    expect(findChatRequestError(page.runtime.getSnapshot().error)?.cause).toBe(
      failure,
    );
  });

  test("preserves a failed reader context before sending and recovers on the next send", async () => {
    const failure = new TypeError("Reader context is unavailable");
    let contextReady = false;
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return new Response(null);
      },
      { preconnect: previousFetch.preconnect },
    );
    const page = openPage({
      getActiveDecision: () => {
        if (!contextReady) {
          throw failure;
        }
        return { decisionId: "decision-reader" };
      },
    });

    await send(page);
    const error = findChatRequestError(page.runtime.getSnapshot().error);
    expect(requests).toBe(0);
    expect(error?.kind).toBe("preparation_failed");
    expect(error?.cause).toBe(failure);
    expect(answerText(page.runtime.getSnapshot())).toBe("");

    contextReady = true;
    const server = installStream();
    const sent = send(page);
    await tick();
    server.push(
      RUN_STARTED,
      ANSWER_STARTED,
      ...textDeltas(1),
      { messageId: ANSWER_ID, type: "TEXT_MESSAGE_END" },
      { runId: RUN_ID, threadId: THREAD_ID, type: "RUN_FINISHED" },
    );
    server.close();
    expect(await sent).toEqual(Result.ok(undefined));
    expect(page.runtime.getSnapshot().error).toBeUndefined();
    expect(answerText(page.runtime.getSnapshot())).toBe("0 ");
  });

  test("retains a typed connection failure through SDK stream error replay", async () => {
    const failure = new TypeError("Failed to fetch");
    globalThis.fetch = Object.assign(
      async () => {
        throw failure;
      },
      {
        preconnect: previousFetch.preconnect,
      },
    );
    const page = openPage();
    await send(page);
    const error = findChatRequestError(page.runtime.getSnapshot().error);
    expect(error?.kind).toBe("connection_failed");
    expect(error?.cause).toBe(failure);
    expect(
      page.errors.some(
        (reported) => findChatRequestError(reported)?.cause === failure,
      ),
    ).toBe(true);
  });

  test("classifies a timeout while the SDK reads the response body", async () => {
    const failure = new DOMException("Stream deadline", "TimeoutError");
    let failStream: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        failStream = () => controller.error(failure);
      },
    });
    globalThis.fetch = Object.assign(
      async () =>
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      { preconnect: previousFetch.preconnect },
    );
    const page = openPage();
    const sent = send(page);
    await tick();
    failStream?.();
    await sent;
    expect(findChatRequestError(page.runtime.getSnapshot().error)?.kind).toBe(
      "timed_out",
    );
    expect(findChatRequestError(page.runtime.getSnapshot().error)?.cause).toBe(
      failure,
    );
  });

  test("a concurrent dropped send remains recoverable by the send queue", async () => {
    const { page, server, sent } = await openStreamingPage();
    const dropped = await Result.tryPromise({
      try: async () =>
        await sendThreadChatMessage(page.runtime, {
          content: "A second question",
          id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000002"),
        }),
      catch: (error) => error,
    });
    expect(dropped.isErr()).toBe(true);
    if (dropped.isErr()) {
      expect(isChatMessageStartError(dropped.error)).toBe(true);
      expect(findChatRequestError(dropped.error)?.kind).toBe("not_started");
    }
    server.close();
    await sent;
  });

  test("a concurrent route handoff retains the busy-send classification", async () => {
    const { page, server, sent } = await openStreamingPage();
    const dropped = await Result.tryPromise({
      try: async () =>
        await page.runtime.startRouteHandoffMessage({
          content: "A second question",
          id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000002"),
        }),
      catch: (error) => error,
    });
    expect(dropped.isErr()).toBe(true);
    if (dropped.isErr()) {
      expect(isChatMessageStartError(dropped.error)).toBe(true);
      expect(findChatRequestError(dropped.error)?.kind).toBe("not_started");
    }
    server.close();
    await sent;
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

test.each([PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired, null])(
  "provider diagnostic %s survives the real SDK stream and persisted reload",
  async (code) => {
    const diagnostic = {
      provider: "anthropic",
      code,
      message: `The complete provider reason.\n${"Workspace details ".repeat(30)}`,
    } satisfies ProviderDiagnostic;
    const { page, server, sent } = await openStreamingPage();
    server.push({
      type: "RUN_ERROR",
      runId: RUN_ID,
      threadId: THREAD_ID,
      message: "provider_credentials_rejected",
      metadata: { providerDiagnostic: diagnostic },
    });
    server.close();
    await waitFor(() => page.runtime.getSnapshot().error !== undefined);
    expect(await sent).toEqual(Result.ok(undefined));
    const streamed = providerDiagnosticFromThrown(
      page.runtime.getSnapshot().error,
    );
    expect(streamed).toEqual(diagnostic);
    expect(providerDiagnosticFromThrown(page.errors.at(0))).toEqual(diagnostic);
    const stored = {
      id: ANSWER_ID,
      role: "assistant",
      parts: [],
      metadata: {
        turnOutcome: {
          type: "failed",
          error: "provider_credentials_rejected",
          providerDiagnostic: diagnostic,
        },
      },
    } satisfies PersistedChatMessage;
    expect(
      providerDiagnosticFromThrown(
        getChatAssistantTurnError(structuredClone(stored)),
      ),
    ).toEqual(streamed);
  },
);
