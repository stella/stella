import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect } from "bun:test";

import {
  CHAT_TURN_ID_HEADER,
  CHAT_TURN_NOT_OWNED_ERROR_CODE,
} from "@stll/api-contract";
import { sleep as ownerSleep } from "@stll/concurrency/sleep";

import { isChatTurnGenerating } from "@/components/chat/chat-user-actions";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";
import { requestTest as test } from "@/testing/request-test";

// The composer's Stop against a server that owns the turn: the stop reaches
// the server before the page closes its request, the page reloads the thread
// only once the server has settled the turn, a refused stop keeps Stop
// available, and an answer about a turn the page has left changes nothing.

const THREAD_ID = toChatThreadId("thread-stop");
const TURN_A = toSafeId<"chatTurn">("018f0000-0000-7000-8000-00000000000a");
const TURN_B = toSafeId<"chatTurn">("018f0000-0000-7000-8000-00000000000b");
const CANCEL_PATH =
  /\/v1\/chat\/threads\/[^/]+\/turns\/(?<turnId>[^/]+)\/cancel$/u;

type Deferred = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};

const deferred = (): Deferred => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  return { promise, resolve };
};

/** A chat request the server keeps streaming until the page closes it or the
 *  server ends it. */
type OpenChatRequest = {
  aborted: () => boolean;
  end: () => void;
};

type Server = {
  /** Stop requests, in the order the page sent them. */
  cancels: { answer: Deferred; turnId: string }[];
  /** Settles once the page has sent `count` stop requests. */
  cancelsReceived: (count: number) => Promise<void>;
  /** Chat requests past the planned turns, held until the test answers. */
  held: Deferred[];
  /** Chat requests, in the order the page sent them. */
  chats: OpenChatRequest[];
  /** Everything the page asked for, in order. */
  log: string[];
};

const encoder = new TextEncoder();

/** How a served turn answers: text still streaming, or a client call the
 *  page runs once the run has finished. */
type Answer = "client-call" | "streaming";

const CLIENT_CALL_ID = "call-draft";
const DRAFT_INPUT = { name: "NDA", source: "@title NDA" };

const answerEvents = (answer: Answer, turnId: string) => {
  const runId = `run-${turnId}`;
  const messageId = `answer-${turnId}`;
  const start = [
    { runId, threadId: THREAD_ID, type: "RUN_STARTED" },
    { messageId, role: "assistant", type: "TEXT_MESSAGE_START" },
  ];
  switch (answer) {
    case "streaming":
      return [
        ...start,
        { delta: "Drafting", messageId, type: "TEXT_MESSAGE_CONTENT" },
      ];
    case "client-call":
      return [
        ...start,
        {
          parentMessageId: messageId,
          toolCallId: CLIENT_CALL_ID,
          toolCallName: "create-document",
          toolName: "create-document",
          type: "TOOL_CALL_START",
        },
        {
          delta: JSON.stringify(DRAFT_INPUT),
          toolCallId: CLIENT_CALL_ID,
          type: "TOOL_CALL_ARGS",
        },
        {
          input: DRAFT_INPUT,
          toolCallId: CLIENT_CALL_ID,
          toolCallName: "create-document",
          toolName: "create-document",
          type: "TOOL_CALL_END",
        },
        {
          finishReason: "tool_calls",
          runId,
          threadId: THREAD_ID,
          type: "RUN_FINISHED",
        },
      ];
    default:
      answer satisfies never;
      return expect.unreachable(`Unhandled answer: ${String(answer)}`);
  }
};

const openChatResponse = ({
  answer,
  log,
  signal,
  turnId,
}: {
  answer: Answer;
  log: string[];
  signal: AbortSignal | null | undefined;
  turnId: string;
}): { request: OpenChatRequest; response: Response } => {
  let aborted = false;
  let end = () => {};
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const event of answerEvents(answer, turnId)) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      if (answer === "client-call") {
        controller.close();
        return;
      }
      end = () => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ finishReason: "stop", runId: `run-${turnId}`, threadId: THREAD_ID, type: "RUN_FINISHED" })}\n\n`,
          ),
        );
        controller.close();
      };
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          // An aborted stream is already settled; ending it again would throw.
          end = () => {};
          log.push(`abort ${turnId}`);
          controller.error(new DOMException("The page aborted", "AbortError"));
        },
        { once: true },
      );
    },
  });
  return {
    request: { aborted: () => aborted, end: () => end() },
    response: new Response(body, {
      headers: {
        [CHAT_TURN_ID_HEADER]: turnId,
        "Content-Type": "text/event-stream",
      },
    }),
  };
};

const previousFetch = globalThis.fetch;

/** Serves the page's chat requests as turns `turnIds`, in order, and holds
 *  every stop request until the test answers it. */
const installServer = (
  turnIds: readonly string[],
  answer: Answer = "streaming",
): Server => {
  const cancelWaiters: { count: number; resolve: () => void }[] = [];
  const server: Server = {
    cancels: [],
    cancelsReceived: async (count) => {
      if (server.cancels.length >= count) {
        return;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      cancelWaiters.push({ count, resolve: () => resolve(undefined) });
      await promise;
    },
    chats: [],
    held: [],
    log: [],
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const url = new URL(input instanceof Request ? input.url : input);
      const cancel = CANCEL_PATH.exec(url.pathname)?.groups?.["turnId"];
      if (cancel !== undefined) {
        server.log.push(`cancel ${cancel}`);
        const stopAnswer = deferred();
        server.cancels.push({ answer: stopAnswer, turnId: cancel });
        for (const waiter of cancelWaiters) {
          if (server.cancels.length >= waiter.count) {
            waiter.resolve();
          }
        }
        return await stopAnswer.promise;
      }
      const turnId = turnIds[server.chats.length];
      if (turnId === undefined) {
        server.log.push("chat (held)");
        const held = deferred();
        server.held.push(held);
        return await held.promise;
      }
      server.log.push(`chat ${turnId}`);
      const { request, response } = openChatResponse({
        answer,
        log: server.log,
        signal: init?.signal,
        turnId,
      });
      server.chats.push(request);
      return response;
    },
    { preconnect: previousFetch.preconnect },
  );
  return server;
};

const settled = (turnId: string, status: string) =>
  Response.json({ turn: { id: turnId, reason: "user-stop", status } });

const tick = async (times = 20) => {
  for (let index = 0; index < times; index += 1) {
    await ownerSleep(0);
  }
};

type Page = { errors: Error[]; reloads: number; runtime: ChatRuntime };

const openPage = (): Page => {
  const errors: Error[] = [];
  const page: Page = {
    errors,
    reloads: 0,
    runtime: createChatRuntime({
      activeTurnId: null,
      context: undefined,
      initialMessages: [],
      key: { scope: "global", threadId: THREAD_ID },
      onError: (error) => {
        errors.push(error);
      },
      onFinish: () => {},
      reloadThread: () => {
        page.reloads += 1;
      },
    }),
  };
  return page;
};

const send = async (page: Page, id: string) =>
  await Result.tryPromise(
    async () =>
      await sendThreadChatMessage(page.runtime, {
        content: "Draft the NDA",
        id: toSafeId<"chatMessage">(id),
      }),
  );

describe("the composer's Stop", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("stops the turn on the server, then closes the request and reloads", async () => {
    const server = installServer([TURN_A]);
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000001");
    await tick();

    page.runtime.stop();
    // Shown stopped at once, while the server has not answered.
    expect(page.runtime.getSnapshot()).toMatchObject({
      stop: { status: "pending", turnId: TURN_A },
      turnAbandoned: true,
    });
    await tick();
    expect(server.log).toEqual([`chat ${TURN_A}`, `cancel ${TURN_A}`]);
    expect(server.chats[0]?.aborted()).toBe(false);

    server.cancels[0]?.answer.resolve(settled(TURN_A, "cancelled"));
    await tick();
    expect(server.log).toEqual([
      `chat ${TURN_A}`,
      `cancel ${TURN_A}`,
      `abort ${TURN_A}`,
    ]);
    expect(page.reloads).toBe(1);
    expect(page.runtime.getSnapshot().stop).toEqual({ status: "idle" });
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("Stop before response headers cancels the accepted turn once it is named", async () => {
    const server = installServer([TURN_A]);
    const serverFetch = globalThis.fetch;
    const headers = Promise.withResolvers<undefined>();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await serverFetch(input, init);
        if (
          new URL(
            input instanceof Request ? input.url : input,
          ).pathname.endsWith("/chat")
        ) {
          await headers.promise;
        }
        return response;
      },
      { preconnect: () => undefined },
    );
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000008");
    await tick();
    page.runtime.stop();
    await tick();
    expect(server.chats.at(0)?.aborted()).toBe(false);
    expect(server.cancels).toHaveLength(0);
    headers.resolve(undefined);
    await tick();
    expect(server.cancels.map(({ turnId }) => turnId)).toEqual([TURN_A]);
    server.cancels.at(0)?.answer.resolve(settled(TURN_A, "cancelled"));
    await tick();
    expect(server.chats.at(0)?.aborted()).toBe(true);
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("keeps Stop available when the server refuses it", async () => {
    const server = installServer([TURN_A]);
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000002");
    await tick();

    page.runtime.stop();
    await tick();
    server.cancels[0]?.answer.resolve(
      Response.json({ message: "Unavailable" }, { status: 503 }),
    );
    await tick();

    expect(page.runtime.getSnapshot()).toMatchObject({
      stop: { status: "failed", turnId: TURN_A },
      turnAbandoned: false,
    });
    // Not presented as stopped: the request stays open and nothing reloads.
    expect(server.chats[0]?.aborted()).toBe(false);
    expect(page.reloads).toBe(0);

    page.runtime.stop();
    await tick();
    expect(server.cancels.map(({ turnId }) => turnId)).toEqual([
      TURN_A,
      TURN_A,
    ]);
    server.cancels[1]?.answer.resolve(settled(TURN_A, "cancelled"));
    await tick();
    expect(server.chats[0]?.aborted()).toBe(true);
    expect(page.reloads).toBe(1);
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("ignores an answer about a turn the page has left", async () => {
    const server = installServer([TURN_A, TURN_B]);
    const page = openPage();
    const firstSent = send(page, "018f0000-0000-7000-8000-000000000003");
    await tick();
    page.runtime.stop();
    await tick();
    // The server finished the turn before the stop reached it, and the user
    // sent the next message.
    server.chats[0]?.end();
    await tick();
    const secondSent = send(page, "018f0000-0000-7000-8000-000000000004");
    await tick();
    expect(server.chats).toHaveLength(2);

    server.cancels[0]?.answer.resolve(settled(TURN_A, "completed"));
    await tick();

    expect(server.chats[1]?.aborted()).toBe(false);
    expect(page.reloads).toBe(0);
    expect(page.runtime.getSnapshot().stop).toEqual({ status: "idle" });
    server.chats[1]?.end();
    expect(await firstSent).toEqual(Result.ok(undefined));
    expect(await secondSent).toEqual(Result.ok(undefined));
  });

  test("keeps a stopped turn's late client result on the page", async () => {
    // A continuation would be served, so only the page can keep it back.
    const server = installServer([TURN_A, TURN_A], "client-call");
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000005");
    await tick();
    // The fixture must reach the fault: the page runs the turn's client call.
    expect(
      page.runtime
        .getSnapshot()
        .messages.flatMap(({ parts }) => parts)
        .some(
          (part) => part.type === "tool-call" && part.id === CLIENT_CALL_ID,
        ),
    ).toBe(true);
    page.runtime.stop();
    await tick();

    await page.runtime.addToolResult({
      output: { destination: "download", fileName: "NDA.docx", success: true },
      tool: "create-document",
      toolCallId: CLIENT_CALL_ID,
    });
    await tick();

    expect(server.log).toEqual([`chat ${TURN_A}`, `cancel ${TURN_A}`]);
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("takes a refused continuation of the stopped turn quietly", async () => {
    const server = installServer([TURN_A], "client-call");
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000006");
    await tick();
    // The page posts the call's result, and the user stops before the
    // server answers it.
    const continuation = Result.tryPromise(
      async () =>
        await page.runtime.addToolResult({
          output: {
            destination: "download",
            fileName: "NDA.docx",
            success: true,
          },
          tool: "create-document",
          toolCallId: CLIENT_CALL_ID,
        }),
    );
    await tick();
    // The fixture must reach the fault: the continuation is in flight.
    expect(server.held).toHaveLength(1);
    page.runtime.stop();
    await tick();
    // The server settled the stop first, so it refuses the result, and says
    // so before the page has the stop's answer.
    server.held[0]?.resolve(
      Response.json(
        {
          code: CHAT_TURN_NOT_OWNED_ERROR_CODE,
          message: "Chat turn has no durable execution owner",
        },
        { status: 409 },
      ),
    );
    await tick();
    server.cancels[0]?.answer.resolve(settled(TURN_A, "cancelled"));
    await tick();

    expect(page.errors).toEqual([]);
    expect(page.runtime.getSnapshot()).toMatchObject({
      error: undefined,
      stop: { status: "idle" },
    });
    expect(page.reloads).toBe(1);
    expect(await continuation).toEqual(Result.ok(undefined));
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("takes a refused continuation of a turn the server settled quietly", async () => {
    const server = installServer([TURN_A], "client-call");
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000016");
    await tick();
    const messagesBeforeResult = page.runtime.getSnapshot().messages;
    const continuation = Result.tryPromise(
      async () =>
        await page.runtime.addToolResult({
          output: {
            destination: "download",
            fileName: "NDA.docx",
            success: true,
          },
          tool: "create-document",
          toolCallId: CLIENT_CALL_ID,
        }),
    );
    await tick();
    // The fixture must reach the fault: the continuation is in flight.
    expect(server.held).toHaveLength(1);
    // Nobody stopped the turn: the server ended it on its own, so it refuses
    // the result.
    server.held[0]?.resolve(
      Response.json(
        {
          code: CHAT_TURN_NOT_OWNED_ERROR_CODE,
          message: "Chat turn has no durable execution owner",
        },
        { status: 409 },
      ),
    );
    await tick();

    expect(page.errors).toEqual([]);
    expect(page.runtime.getSnapshot().error).toBeUndefined();
    expect(page.reloads).toBe(1);
    // The refused result never became durable, so the page drops it.
    expect(page.runtime.getSnapshot().messages).toEqual(messagesBeforeResult);
    expect(server.cancels).toHaveLength(0);
    expect(await continuation).toEqual(Result.ok(undefined));
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("leaving the thread closes the request and asks the server nothing", async () => {
    const server = installServer([TURN_A]);
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000007");
    await tick();

    page.runtime.leave();
    await tick();

    expect(server.log).toEqual([`chat ${TURN_A}`, `abort ${TURN_A}`]);
    expect(page.reloads).toBe(1);
    expect(page.runtime.getSnapshot().stop).toEqual({ status: "idle" });
    expect(await sent).toEqual(Result.ok(undefined));
  });

  test("a failed stop poll keeps Stop shown and reloads once the stop settles", async () => {
    const server = installServer([TURN_A]);
    const page = openPage();
    const sent = send(page, "018f0000-0000-7000-8000-000000000008");
    await tick();
    page.runtime.stop();
    await tick();
    // Another instance runs the turn: the stop is recorded, not settled.
    server.cancels[0]?.answer.resolve(
      Response.json(
        { turn: { id: TURN_A, status: "running" } },
        { status: 202 },
      ),
    );
    // The page asks again after its poll interval (500 ms).
    await server.cancelsReceived(2);
    // The fixture must reach the fault: the page asked again, and the server
    // held its request open until it accepted the stop.
    expect(server.cancels).toHaveLength(2);
    expect(server.chats[0]?.aborted()).toBe(true);
    server.cancels[1]?.answer.resolve(
      Response.json({ message: "Unavailable" }, { status: 503 }),
    );
    await tick();

    // The server holds the stop, so the turn is still shown stopping: the
    // composer keeps Stop, and a sent message waits in the queue.
    const shown = page.runtime.getSnapshot();
    expect(shown).toMatchObject({
      stop: { status: "pending", turnId: TURN_A },
      turnAbandoned: true,
    });
    expect(
      isChatTurnGenerating({
        hasError: shown.error !== undefined,
        messages: shown.messages,
        requestActive: shown.isLoading,
        sessionGenerating: shown.sessionGenerating,
        stopStatus: shown.stop.status,
      }),
    ).toBe(true);
    expect(page.reloads).toBe(0);

    await server.cancelsReceived(3);
    expect(server.cancels).toHaveLength(3);
    server.cancels[2]?.answer.resolve(settled(TURN_A, "cancelled"));
    await tick();

    expect(page.reloads).toBe(1);
    expect(page.runtime.getSnapshot().stop).toEqual({ status: "idle" });
    expect(await sent).toEqual(Result.ok(undefined));
  });
});
