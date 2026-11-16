import { afterEach, expect, test } from "bun:test";

import {
  CHAT_LOCAL_RUN_COMPUTER_EVENT,
  type ChatLocalRunComputerEvent,
} from "@stll/api-contract/chat-run-target";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

import { createChatRuntime } from "./chat-runtime";

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
});

const RUN_ID = "run-local";
const THREAD_ID = "thread-local";

const computerEvent = (value: ChatLocalRunComputerEvent) => ({
  type: "CUSTOM",
  name: CHAT_LOCAL_RUN_COMPUTER_EVENT,
  value,
});

/**
 * A server whose running turn the page rejoins: the run log replays what the
 * test sends, and the stream stays open until the test ends it.
 */
const installRunningTurn = () => {
  const encoder = new TextEncoder();
  let sent = 0;
  let joined: ReadableStreamDefaultController<Uint8Array> | null = null;
  const queued: unknown[] = [];
  const write = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: unknown,
  ) => {
    controller.enqueue(
      encoder.encode(`id: ${String(sent)}\ndata: ${JSON.stringify(event)}\n\n`),
    );
    sent += 1;
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/join")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              joined = controller;
              for (const event of queued.splice(0)) {
                write(controller, event);
              }
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return Response.json({
        type: "running",
        turnId: "turn-local",
        runId: RUN_ID,
      });
    },
    { preconnect: () => undefined },
  );
  return {
    send: (...events: unknown[]) => {
      for (const event of events) {
        if (joined === null) {
          queued.push(event);
        } else {
          write(joined, event);
        }
      }
    },
    end: () => joined?.close(),
  };
};

/** A page loaded while its thread's turn still runs: a reload mid-turn. */
const openLoadedTurn = () =>
  createChatRuntime({
    activeTurnId: toSafeId<"chatTurn">("018f0000-0000-7000-8000-00000000000b"),
    context: undefined,
    initialMessages: [
      {
        id: "question",
        role: "user",
        parts: [{ type: "text", content: "Which leases end this year?" }],
      },
    ],
    key: { scope: "global", threadId: toChatThreadId(THREAD_ID) },
    onError: () => undefined,
    onFinish: () => undefined,
    reloadThread: () => undefined,
  });

const awaitSnapshot = async (
  runtime: ReturnType<typeof openLoadedTurn>,
  condition: (snapshot: ReturnType<typeof runtime.getSnapshot>) => boolean,
) => {
  if (condition(runtime.getSnapshot())) {
    return;
  }
  const done = Promise.withResolvers<undefined>();
  const unsubscribe = runtime.subscribe(() => {
    if (condition(runtime.getSnapshot())) {
      done.resolve(undefined);
    }
  });
  try {
    await done.promise;
  } finally {
    unsubscribe();
  }
};

const answerText = (runtime: ReturnType<typeof openLoadedTurn>) =>
  runtime
    .getSnapshot()
    .messages.filter(({ role }) => role === "assistant")
    .flatMap(({ parts }) =>
      parts.flatMap((part) => (part.type === "text" ? [part.content] : [])),
    )
    .join("");

test("a page loaded while the turn's computer is away shows the wait until output resumes", async () => {
  const server = installRunningTurn();
  server.send(
    { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
    { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Lease " },
    computerEvent({ status: "waiting" }),
  );
  const runtime = openLoadedTurn();
  const unsubscribe = runtime.subscribe(() => undefined);
  try {
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait !== null);
    expect(runtime.getSnapshot()).toMatchObject({
      isLoading: true,
      computerWait: { status: "waiting" },
    });
    expect(answerText(runtime)).toBe("Lease ");
    // The page joined this turn; its live status counts from the server.
    expect(runtime.getSnapshot().turnSentAt).toBeNull();

    server.send(computerEvent({ status: "connected" }), {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "answer",
      delta: "one",
    });
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait === null);
    // The computer is back while the turn still runs, not because it ended.
    expect(runtime.getSnapshot().isLoading).toBe(true);

    server.send(
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", runId: RUN_ID, threadId: THREAD_ID },
    );
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
    expect(answerText(runtime)).toBe("Lease one");
    expect(runtime.getSnapshot().computerWait).toBeNull();
  } finally {
    unsubscribe();
  }
});

test("a turn that ends while its computer is away leaves no wait behind", async () => {
  const server = installRunningTurn();
  server.send(
    { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
    computerEvent({ status: "waiting" }),
  );
  const runtime = openLoadedTurn();
  const unsubscribe = runtime.subscribe(() => undefined);
  try {
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait !== null);
    server.send({
      type: "RUN_ERROR",
      runId: RUN_ID,
      threadId: THREAD_ID,
      message: "The computer stopped running the turn.",
      code: "local_runner_unavailable",
    });
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
    expect(runtime.getSnapshot().computerWait).toBeNull();
  } finally {
    unsubscribe();
  }
});

test("a turn its computer has not picked up yet waits from when it was sent, until the computer has it", async () => {
  const sentAt = "2026-11-11T08:56:51.000Z";
  const server = installRunningTurn();
  server.send(
    { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
    computerEvent({ status: "delivering", since: sentAt }),
  );
  const runtime = openLoadedTurn();
  const unsubscribe = runtime.subscribe(() => undefined);
  try {
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait !== null);
    expect(runtime.getSnapshot().computerWait).toEqual({
      status: "delivering",
      since: sentAt,
    });
    server.send(computerEvent({ status: "connected" }), {
      type: "TEXT_MESSAGE_START",
      messageId: "answer",
      role: "assistant",
    });
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait === null);
    expect(runtime.getSnapshot().isLoading).toBe(true);
    server.send({ type: "RUN_FINISHED", runId: RUN_ID, threadId: THREAD_ID });
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
  } finally {
    unsubscribe();
  }
});
