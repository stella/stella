import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  type StoredSession,
} from "@/connection/session";

import {
  answerEntry,
  applyChatEvent,
  cancelChatTurn,
  chatSendBody,
  createSseParser,
  EMPTY_ANSWER,
  joinChatTurn,
  parseChatEvent,
  probeChatTurn,
  sendChatMessage,
} from "./chat-stream";
import type { ChatEvent, StreamedAnswer, StreamFetch } from "./chat-stream";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

/** A source whose refresh answers `access-1`, so a retried request shows it. */
const sourceFor = () =>
  createAccessTokenSource({
    fetch: async () =>
      Response.json({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-2",
        token_type: "Bearer",
      }),
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store: {
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    },
  });

const THREAD_ID = "00000000-0000-7000-8000-000000000002";
const MESSAGE_ID = "00000000-0000-7000-8000-000000000001";
const ANSWER_ID = "00000000-0000-7000-8000-000000000003";
const TURN_ID = "00000000-0000-7000-8000-000000000004";

/** The shape of a recorded run: text, a tool, more text, then the end. */
const RUN_EVENTS = [
  { type: "CUSTOM", name: "run.accepted", value: {} },
  { type: "RUN_STARTED", runId: "run-1", threadId: THREAD_ID },
  { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
  {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: ANSWER_ID,
    delta: "Checking the ",
  },
  { type: "TEXT_MESSAGE_CONTENT", messageId: ANSWER_ID, delta: "register" },
  { type: "TEXT_MESSAGE_END", messageId: ANSWER_ID },
  {
    type: "TOOL_CALL_START",
    toolCallId: "call-1",
    toolCallName: "list_templates",
  },
  { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "{}" },
  { type: "TOOL_CALL_END", toolCallId: "call-1" },
  { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: ANSWER_ID, delta: "Two found." },
  { type: "TEXT_MESSAGE_END", messageId: ANSWER_ID },
  { type: "RUN_FINISHED", runId: "run-1", threadId: THREAD_ID },
];

const sse = (events: readonly unknown[], firstId = 1) =>
  events
    .map(
      (event, index) =>
        `id: ${index + firstId}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");

const streamOf = (chunks: readonly string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

const reduce = (events: readonly ChatEvent[]): StreamedAnswer => {
  let answer = EMPTY_ANSWER;
  for (const event of events) {
    answer = applyChatEvent(answer, event);
  }
  return answer;
};

describe("reading server-sent events", () => {
  test("yields the same events wherever the body is cut", () => {
    const body = `: heartbeat\r\nid: 7\r\ndata: {"a":1}\r\n\r\ndata: line one\ndata: line two\nretry: 10\n\n`;
    const whole = createSseParser()(body);
    expect(whole).toEqual([
      { id: "7", data: '{"a":1}' },
      { id: "7", data: "line one\nline two" },
    ]);
    for (let cut = 0; cut <= body.length; cut += 1) {
      const parse = createSseParser();
      expect([...parse(body.slice(0, cut)), ...parse(body.slice(cut))]).toEqual(
        whole,
      );
    }
  });

  test("holds an event until its blank line arrives", () => {
    const parse = createSseParser();
    expect(parse('id: 1\ndata: {"x":1}\n')).toEqual([]);
    expect(parse("\n")).toEqual([{ id: "1", data: '{"x":1}' }]);
  });
});

describe("drawing an answer from its events", () => {
  const events = RUN_EVENTS.flatMap(
    (event) => parseChatEvent(JSON.stringify(event)) ?? [],
  );

  test("keeps the text segments, the tools between them, and the end", () => {
    const answer = reduce(events);
    expect(answer).toEqual({
      messageId: ANSWER_ID,
      segments: ["Checking the register", "Two found."],
      tools: ["list_templates"],
      status: "finished",
    });
    expect(answerEntry(answer, "2026-10-20T10:00:00.000Z")).toEqual({
      id: ANSWER_ID,
      role: "assistant",
      createdAt: "2026-10-20T10:00:00.000Z",
      text: "Checking the register\n\nTwo found.",
      tools: ["list_templates"],
    });
  });

  test("is still streaming until the run says it finished", () => {
    expect(reduce(events.slice(0, -1)).status).toBe("streaming");
  });

  test("tells a stop, a question for the web app, and a failure apart", () => {
    const end = (event: unknown) =>
      reduce([parseChatEvent(JSON.stringify(event)) ?? []].flat()).status;
    expect(end({ type: "RUN_FINISHED", outcome: { type: "cancelled" } })).toBe(
      "stopped",
    );
    expect(end({ type: "RUN_FINISHED", outcome: { type: "interrupt" } })).toBe(
      "needs-input",
    );
    expect(end({ type: "RUN_ERROR", message: "Provider failed" })).toBe(
      "failed",
    );
  });

  test("passes over events it does not draw, and data that is not JSON", () => {
    expect(parseChatEvent('{"type":"MESSAGES_SNAPSHOT","messages":[]}')).toBe(
      undefined,
    );
    expect(parseChatEvent("not json")).toBe(undefined);
  });
});

describe("the send envelope", () => {
  test("names a matter's thread's matter in the forwarded input", () => {
    const body = chatSendBody({
      anonymized: false,
      matterId: "matter-1",
      messageId: MESSAGE_ID,
      runId: "run-1",
      text: "Check the register",
      threadId: THREAD_ID,
    });
    expect(body.forwardedProps).toMatchObject({
      threadId: THREAD_ID,
      workspaceId: "matter-1",
    });
    expect(body.data).toEqual(body.forwardedProps);
    expect(body).not.toHaveProperty("workspaceId");
    expect(
      chatSendBody({
        anonymized: false,
        matterId: undefined,
        messageId: MESSAGE_ID,
        runId: "run-1",
        text: "Check the register",
        threadId: THREAD_ID,
      }).forwardedProps,
    ).not.toHaveProperty("workspaceId");
  });

  test("repeats the forwarded input as data and names the message", () => {
    const body = chatSendBody({
      anonymized: false,
      matterId: undefined,
      messageId: MESSAGE_ID,
      runId: "run-1",
      text: "Check the register",
      threadId: THREAD_ID,
    });
    expect(body.data).toEqual(body.forwardedProps);
    expect(body.forwardedProps).toEqual({
      threadId: THREAD_ID,
      runId: "run-1",
      sendMode: "rawOverride",
      message: {
        id: MESSAGE_ID,
        role: "user",
        parts: [{ type: "text", content: "Check the register" }],
      },
    });
    expect(body.messages).toEqual([
      { id: MESSAGE_ID, role: "user", content: "Check the register" },
    ]);
  });

  test("keeps a thread that sent anonymized text anonymized", () => {
    const body = chatSendBody({
      anonymized: true,
      matterId: undefined,
      messageId: MESSAGE_ID,
      runId: "run-1",
      text: "Check the register",
      threadId: THREAD_ID,
    });
    expect(body.forwardedProps.sendMode).toBe("anonymized");
    expect(body.data.sendMode).toBe("anonymized");
  });
});

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

const streamingFetch = (
  answer: (call: Call) => Response,
): { fetch: StreamFetch; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = {
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
      };
      calls.push(call);
      return answer(call);
    },
  };
};

describe("sending a message", () => {
  test("posts the envelope and streams the answer, naming the turn first", async () => {
    const order: string[] = [];
    const events: ChatEvent[] = [];
    const body = sse(RUN_EVENTS);
    const { calls, fetch } = streamingFetch(
      () =>
        new Response(streamOf([body.slice(0, 50), body.slice(50)]), {
          headers: { [CHAT_TURN_ID_HEADER]: TURN_ID },
        }),
    );
    const sent = await sendChatMessage({
      anonymized: false,
      fetch,
      matterId: undefined,
      messageId: MESSAGE_ID,
      onEvent: (event) => {
        order.push("event");
        events.push(event);
      },
      onTurn: (turnId) => {
        order.push(`turn ${turnId}`);
      },
      runId: "run-1",
      signal: new AbortController().signal,
      source: sourceFor(),
      text: "Check the register",
      threadId: THREAD_ID,
    });

    expect(sent.isOk() ? sent.value : sent.error).toEqual({
      lastEventId: String(RUN_EVENTS.length),
    });
    expect(order[0]).toBe(`turn ${TURN_ID}`);
    expect(reduce(events).segments).toEqual([
      "Checking the register",
      "Two found.",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://stella.example.com/v1/chat");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer access-0");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(
      chatSendBody({
        anonymized: false,
        matterId: undefined,
        messageId: MESSAGE_ID,
        runId: "run-1",
        text: "Check the register",
        threadId: THREAD_ID,
      }),
    );
  });

  test("runs once more on a fresh token when the server rejects the first", async () => {
    const { calls, fetch } = streamingFetch((call) =>
      call.headers["Authorization"] === "Bearer access-0"
        ? new Response(null, { status: 401 })
        : new Response(streamOf([sse(RUN_EVENTS)])),
    );
    const sent = await sendChatMessage({
      anonymized: false,
      fetch,
      matterId: undefined,
      messageId: MESSAGE_ID,
      onEvent: () => {},
      onTurn: () => {},
      runId: "run-1",
      signal: new AbortController().signal,
      source: sourceFor(),
      text: "Hello",
      threadId: THREAD_ID,
    });
    expect(sent.isOk()).toBe(true);
    expect(calls.map((call) => call.headers["Authorization"])).toEqual([
      "Bearer access-0",
      "Bearer access-1",
    ]);
  });

  test("reports the status of a refused send", async () => {
    const { fetch } = streamingFetch(() => new Response("{}", { status: 409 }));
    const sent = await sendChatMessage({
      anonymized: false,
      fetch,
      matterId: undefined,
      messageId: MESSAGE_ID,
      onEvent: () => {},
      onTurn: () => {},
      runId: "run-1",
      signal: new AbortController().signal,
      source: sourceFor(),
      text: "Hello",
      threadId: THREAD_ID,
    });
    expect(
      Result.isError(sent) && sent.error.error._tag === "ApiRequestError"
        ? sent.error.error.status
        : undefined,
    ).toBe(409);
  });

  test("ends quietly on abort, keeping the last event id it read", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    // Like a platform fetch, the body errors once its request is aborted.
    const fetch: StreamFetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode(sse(RUN_EVENTS.slice(0, 4))));
            init.signal.addEventListener("abort", () => {
              stream.error(init.signal.reason);
            });
          },
        }),
      );
    const sent = await sendChatMessage({
      anonymized: false,
      fetch,
      matterId: undefined,
      messageId: MESSAGE_ID,
      onEvent: (event) => {
        if (event.type === "TEXT_MESSAGE_CONTENT") {
          controller.abort();
        }
      },
      onTurn: () => {},
      runId: "run-1",
      signal: controller.signal,
      source: sourceFor(),
      text: "Hello",
      threadId: THREAD_ID,
    });
    expect(sent.isOk() ? sent.value : sent.error).toEqual({
      lastEventId: "4",
    });
  });
});

describe("rejoining a turn", () => {
  test("keeps the last event id it read when the stream breaks", async () => {
    const encoder = new TextEncoder();
    // The connection drops after the first text arrived, mid-turn.
    const { fetch } = streamingFetch(() => {
      let pulled = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            if (pulled) {
              stream.error(new TypeError("The network connection was lost."));
              return;
            }
            pulled = true;
            stream.enqueue(encoder.encode(sse(RUN_EVENTS.slice(0, 4))));
          },
        }),
      );
    });
    const events: ChatEvent[] = [];
    const joined = await joinChatTurn({
      fetch,
      lastEventId: undefined,
      matterId: undefined,
      onEvent: (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
      source: sourceFor(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(reduce(events).segments).toEqual(["Checking the "]);
    expect(
      Result.isError(joined)
        ? [joined.error.error._tag, joined.error.lastEventId]
        : joined.value,
    ).toEqual(["ApiRequestError", "4"]);
  });

  test("asks for the events after the last one read", async () => {
    const { calls, fetch } = streamingFetch(
      () => new Response(streamOf([sse(RUN_EVENTS.slice(4), 5)])),
    );
    const events: ChatEvent[] = [];
    const joined = await joinChatTurn({
      fetch,
      lastEventId: "4",
      matterId: "matter-1",
      onEvent: (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
      source: sourceFor(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(joined.isOk() ? joined.value : joined.error).toEqual({
      lastEventId: String(RUN_EVENTS.length),
    });
    expect(calls[0]?.url).toBe(
      `https://stella.example.com/v1/chat/threads/${THREAD_ID}/turns/${TURN_ID}/join?workspaceId=matter-1`,
    );
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["Last-Event-ID"]).toBe("4");
    expect(reduce(events).status).toBe("finished");
  });

  test("replays from the start when nothing was read", async () => {
    const { calls, fetch } = streamingFetch(
      () => new Response(streamOf([sse(RUN_EVENTS)])),
    );
    await joinChatTurn({
      fetch,
      lastEventId: undefined,
      matterId: undefined,
      onEvent: () => {},
      signal: new AbortController().signal,
      source: sourceFor(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(calls[0]?.headers["Last-Event-ID"]).toBe("-1");
  });

  test("reads where the turn stands", async () => {
    const urls: string[] = [];
    const fetch: Fetch = async (url) => {
      urls.push(url);
      return Response.json({ type: "running", turnId: TURN_ID, runId: "r" });
    };
    const probe = await probeChatTurn({
      fetch,
      matterId: undefined,
      source: sourceFor(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(probe.isOk() ? probe.value : probe.error).toBe("running");
    expect(urls).toEqual([
      `https://stella.example.com/v1/chat/threads/${THREAD_ID}/turns/${TURN_ID}/resume`,
    ]);
  });
});

describe("stopping a turn", () => {
  test("posts the cancel and accepts the server's answer", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const fetch: Fetch = async (url, init) => {
      calls.push({ url, method: init?.method });
      return Response.json({ turn: {} }, { status: 202 });
    };
    const stopped = await cancelChatTurn({
      fetch,
      source: sourceFor(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(stopped.isOk()).toBe(true);
    expect(calls).toEqual([
      {
        url: `https://stella.example.com/v1/chat/threads/${THREAD_ID}/turns/${TURN_ID}/cancel`,
        method: "POST",
      },
    ]);
  });
});
