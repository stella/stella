import {
  afterEach,
  beforeEach,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import {
  SSE_HEARTBEAT_FRAME,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_SILENCE_BOUND_MS,
} from "@stll/api-contract/sse-heartbeat";

import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

// A chat stream is bounded by its liveness, never by how long it has run. A
// turn on the member's computer works for hours, and the server writes a
// keep-alive frame whenever it has nothing else to say: while those arrive the
// page keeps its one request, and only a stream that falls silent is given up
// and rejoined, as a dropped connection is.
//
// The clock is the test's: timers and `AbortSignal.timeout` both run on it,
// so a deadline on the whole request, however it is spelled, cuts the stream
// here exactly as it would in a browser.

const THREAD_ID = toChatThreadId("thread-liveness");
const TURN_ID = "018f0000-0000-7000-8000-0000000000d1";
const HOUR_MS = 3_600_000;
const encoder = new TextEncoder();
const previousFetch = globalThis.fetch;

const changeListeners = new Set<() => void>();
const notifyChange = () => {
  for (const listener of changeListeners) {
    listener();
  }
};
const awaitCondition = async (condition: () => boolean) => {
  if (condition()) {
    return;
  }
  const done = Promise.withResolvers<undefined>();
  const listener = () => {
    if (condition()) {
      done.resolve(undefined);
    }
  };
  changeListeners.add(listener);
  try {
    await done.promise;
  } finally {
    changeListeners.delete(listener);
  }
};

/** One response body the server holds open. `starving` once the page has
 *  read everything written to it and waits for more. */
type OpenStream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  pending: Uint8Array[];
  starving: boolean;
};

type Served = { lastEventId: string | null; request: string };

/** A server that owns one running turn: it streams the turn's events to the
 *  send and to every join, each from the offset the request names. */
const installServer = () => {
  const requests: Served[] = [];
  const released: unknown[] = [];
  const events: unknown[] = [];
  const open = new Set<OpenStream>();
  let runId = "";
  const frame = (offset: number) =>
    encoder.encode(
      `id: ${String(offset)}\ndata: ${JSON.stringify(events.at(offset))}\n\n`,
    );
  const write = (bytes: Uint8Array) => {
    for (const stream of open) {
      if (stream.starving) {
        stream.starving = false;
        stream.controller.enqueue(bytes);
      } else {
        stream.pending.push(bytes);
      }
    }
  };
  const body = (from: number, signal: AbortSignal | null | undefined) => {
    let stream: OpenStream | undefined;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const opened: OpenStream = {
            controller,
            pending: events
              .slice(from)
              .map((_event, index) => frame(from + index)),
            starving: false,
          };
          stream = opened;
          open.add(opened);
          // The platform fails a body whose request was aborted.
          signal?.addEventListener("abort", () => {
            if (open.delete(opened)) {
              controller.error(signal.reason);
            }
          });
        },
        // No queue of its own, so a pull is the page asking for bytes.
        pull(controller) {
          if (stream === undefined) {
            return;
          }
          const next = stream.pending.shift();
          if (next === undefined) {
            stream.starving = true;
            notifyChange();
            return;
          }
          controller.enqueue(next);
        },
        cancel(reason: unknown) {
          if (stream !== undefined) {
            open.delete(stream);
          }
          released.push(reason);
          notifyChange();
        },
      },
      { highWaterMark: 0 },
    );
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const lastEventId = headers.get("Last-Event-ID");
      requests.push({
        lastEventId,
        request: `${method} ${url.pathname.replace(/^.*\/turns\/[^/]+/u, "")}`,
      });
      notifyChange();
      if (url.pathname.endsWith("/resume")) {
        return Response.json({ type: "running", turnId: TURN_ID, runId });
      }
      if (method === "POST") {
        runId = headers.get("X-Run-Id") ?? "";
      }
      return new Response(
        body(lastEventId === null ? 0 : Number(lastEventId) + 1, init?.signal),
        {
          headers: {
            [CHAT_TURN_ID_HEADER]: TURN_ID,
            "Content-Type": "text/event-stream",
          },
        },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
  return {
    requests,
    /** Why the page let go of each body it stopped reading. */
    released,
    runId: () => runId,
    push: (...pushed: unknown[]) => {
      for (const event of pushed) {
        events.push(event);
        write(frame(events.length - 1));
      }
    },
    beat: () => {
      write(encoder.encode(SSE_HEARTBEAT_FRAME));
    },
    /** The run is over: the server closes every stream it still holds. */
    end: async () => {
      await awaitCondition(() => [...open].every(({ starving }) => starving));
      for (const stream of open) {
        stream.controller.close();
      }
      open.clear();
    },
    /** The page has read all the server wrote and waits on an open stream. */
    drained: async () => {
      await awaitCondition(
        () => open.size > 0 && [...open].every(({ starving }) => starving),
      );
    },
  };
};

let clock = 0;
/** Total deadlines the page armed, each with the time it expires at. */
let deadlines: { at: number; expire: () => void }[] = [];
const elapse = (ms: number) => {
  clock += ms;
  jest.advanceTimersByTime(ms);
  const due = deadlines.filter(({ at }) => at <= clock);
  deadlines = deadlines.filter(({ at }) => at > clock);
  for (const { expire } of due) {
    expire();
  }
};

beforeEach(() => {
  resetChatRequestStateForTests();
  clock = 0;
  deadlines = [];
  jest.useFakeTimers();
  spyOn(performance, "now").mockImplementation(() => clock);
  // The platform's own deadline signal ignores a fake clock; this one runs
  // on the test's, so a total deadline on the request fires when its time
  // comes.
  spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    deadlines.push({
      at: clock + ms,
      expire: () => {
        controller.abort(
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      },
    });
    return controller.signal;
  });
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  mock.restore();
});

/** A page that sent a message and shows the first word of its answer. */
const openTurn = async () => {
  const server = installServer();
  const errors: Error[] = [];
  const runtime = createChatRuntime({
    activeTurnId: null,
    context: undefined,
    initialMessages: [],
    key: { scope: "global", threadId: THREAD_ID },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
    reloadThread: () => undefined,
    // Off the clock, which belongs to the stream's deadlines here.
    scheduleEmit: (emit) => {
      queueMicrotask(emit);
      return () => undefined;
    },
  });
  const reconnecting: boolean[] = [];
  const unsubscribe = runtime.subscribe(() => {
    const next = runtime.getSnapshot().reconnecting;
    if (reconnecting.at(-1) !== next) {
      reconnecting.push(next);
    }
    notifyChange();
  });
  const sent = sendThreadChatMessage(runtime, {
    content: "Run the long job",
    id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-0000000000c1"),
  });
  await awaitCondition(() => server.requests.length === 1);
  server.push(
    { type: "RUN_STARTED", runId: server.runId(), threadId: THREAD_ID },
    { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "One" },
  );
  /** The answer as the page shows it. */
  const answer = () =>
    runtime
      .getSnapshot()
      .messages.filter(({ role }) => role === "assistant")
      .flatMap(({ parts }) => parts);
  const shows = async (text: string) => {
    await awaitCondition(() =>
      answer().some((part) => part.type === "text" && part.content === text),
    );
  };
  await shows("One");
  await server.drained();
  return {
    answer,
    errors,
    finish: async () => {
      server.push(
        { type: "TEXT_MESSAGE_END", messageId: "reply" },
        { type: "RUN_FINISHED", runId: server.runId(), threadId: THREAD_ID },
      );
      await server.end();
      await sent;
      unsubscribe();
      runtime.leave();
    },
    reconnecting,
    runtime,
    server,
    shows,
  };
};

test("a turn that works for hours keeps the one request it was sent on", async () => {
  const page = await openTurn();

  // Twelve hours in which the turn says nothing: the agent thinks, or waits
  // inside a long command. Only the server's keep-alive frames arrive.
  const beats = (12 * HOUR_MS) / SSE_HEARTBEAT_INTERVAL_MS;
  for (let beat = 0; beat < beats; beat += 1) {
    expect(page.server.requests).toHaveLength(1);
    elapse(SSE_HEARTBEAT_INTERVAL_MS);
    page.server.beat();
    await page.server.drained();
  }
  page.server.push({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "reply",
    delta: " two",
  });
  await page.shows("One two");

  expect(page.server.requests).toEqual([
    { lastEventId: null, request: "POST /v1/chat" },
  ]);
  expect(page.server.released).toEqual([]);
  expect(page.reconnecting).toEqual([false]);
  expect(page.errors).toEqual([]);
  expect(page.runtime.getSnapshot().error).toBeUndefined();
  await page.finish();
  expect(page.answer()).toEqual([{ type: "text", content: "One two" }]);
});

test("a stream that falls silent is given up at the bound and rejoined once", async () => {
  const page = await openTurn();

  // No keep-alive frame arrives: the connection is gone, though nothing has
  // said so. One millisecond short of the bound the page still waits.
  elapse(SSE_SILENCE_BOUND_MS - 1);
  expect(page.server.requests).toHaveLength(1);
  expect(page.server.released).toEqual([]);

  elapse(1);
  await awaitCondition(() => page.server.requests.length === 3);
  await page.server.drained();
  page.server.push({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "reply",
    delta: " two",
  });
  await page.shows("One two");

  // The rejoin asks what the turn is doing, then reads on after the last
  // event it showed: nothing shown is replayed and nothing is skipped.
  expect(page.server.requests).toEqual([
    { lastEventId: null, request: "POST /v1/chat" },
    { lastEventId: null, request: "GET /resume" },
    { lastEventId: "2", request: "GET /join" },
  ]);
  expect(page.server.released).toHaveLength(1);
  expect(page.server.released.at(0)).toMatchObject({ name: "TimeoutError" });
  expect(page.reconnecting).toEqual([false, true, false]);
  expect(page.errors).toEqual([]);

  // The stream it rejoined is alive, so it is the last request the turn needs.
  const beats = HOUR_MS / SSE_HEARTBEAT_INTERVAL_MS;
  for (let beat = 0; beat < beats; beat += 1) {
    elapse(SSE_HEARTBEAT_INTERVAL_MS);
    page.server.beat();
    await page.server.drained();
  }
  expect(page.server.requests).toHaveLength(3);
  expect(page.runtime.getSnapshot().error).toBeUndefined();
  await page.finish();
  expect(page.answer()).toEqual([{ type: "text", content: "One two" }]);
});
