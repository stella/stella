import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CHAT_TURN_ID_HEADER,
  CHAT_TURN_NOT_OWNED_ERROR_CODE,
} from "@stll/api-contract";

import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

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
  const server: Server = { cancels: [], chats: [], held: [], log: [] };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const url = new URL(input instanceof Request ? input.url : input);
      const cancel = CANCEL_PATH.exec(url.pathname)?.groups?.["turnId"];
      if (cancel !== undefined) {
        server.log.push(`cancel ${cancel}`);
        const stopAnswer = deferred();
        server.cancels.push({ answer: stopAnswer, turnId: cancel });
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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
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

const send = (page: Page, id: string) => {
  void sendThreadChatMessage(page.runtime, {
    content: "Draft the NDA",
    id: toSafeId<"chatMessage">(id),
  }).catch(() => undefined);
};

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
    send(page, "018f0000-0000-7000-8000-000000000001");
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
  });

  test("keeps Stop available when the server refuses it", async () => {
    const server = installServer([TURN_A]);
    const page = openPage();
    send(page, "018f0000-0000-7000-8000-000000000002");
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
  });

  test("ignores an answer about a turn the page has left", async () => {
    const server = installServer([TURN_A, TURN_B]);
    const page = openPage();
    send(page, "018f0000-0000-7000-8000-000000000003");
    await tick();
    page.runtime.stop();
    await tick();
    // The server finished the turn before the stop reached it, and the user
    // sent the next message.
    server.chats[0]?.end();
    await tick();
    send(page, "018f0000-0000-7000-8000-000000000004");
    await tick();
    expect(server.chats).toHaveLength(2);

    server.cancels[0]?.answer.resolve(settled(TURN_A, "completed"));
    await tick();

    expect(server.chats[1]?.aborted()).toBe(false);
    expect(page.reloads).toBe(0);
    expect(page.runtime.getSnapshot().stop).toEqual({ status: "idle" });
  });

  test("keeps a stopped turn's late client result on the page", async () => {
    // A continuation would be served, so only the page can keep it back.
    const server = installServer([TURN_A, TURN_A], "client-call");
    const page = openPage();
    send(page, "018f0000-0000-7000-8000-000000000005");
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
  });

  test("takes a refused continuation of the stopped turn quietly", async () => {
    const server = installServer([TURN_A], "client-call");
    const page = openPage();
    send(page, "018f0000-0000-7000-8000-000000000006");
    await tick();
    // The page posts the call's result, and the user stops before the
    // server answers it.
    void page.runtime
      .addToolResult({
        output: {
          destination: "download",
          fileName: "NDA.docx",
          success: true,
        },
        tool: "create-document",
        toolCallId: CLIENT_CALL_ID,
      })
      .catch(() => undefined);
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
  });

  test("leaving the thread closes the request and asks the server nothing", async () => {
    const server = installServer([TURN_A]);
    const page = openPage();
    send(page, "018f0000-0000-7000-8000-000000000007");
    await tick();

    page.runtime.leave();
    await tick();

    expect(server.log).toEqual([`chat ${TURN_A}`, `abort ${TURN_A}`]);
    expect(page.reloads).toBe(1);
    expect(page.runtime.getSnapshot().stop).toEqual({ status: "idle" });
  });
});
