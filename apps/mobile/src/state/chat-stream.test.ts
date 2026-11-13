import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
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
  streamConnectTimeout,
} from "./chat-stream";
import type { ChatEvent, StreamedAnswer, StreamFetch } from "./chat-stream";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

/** A source whose refresh answers `access-1`, so a retried request shows it. */
const sourceFor = () => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
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
    store,
    generation: store.generation(),
  });
};

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
  {
    type: "TOOL_CALL_RESULT",
    messageId: ANSWER_ID,
    toolCallId: "call-1",
    content: '{"templates":[]}',
    role: "tool",
  },
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

/** The answer's texts, in order. */
const textsOf = (answer: StreamedAnswer): string[] =>
  answer.parts.flatMap((part) => (part.type === "text" ? [part.content] : []));

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

  test("keeps the texts, the tools between them in order, and the end", () => {
    const answer = reduce(events);
    expect(answer).toEqual({
      messageId: ANSWER_ID,
      parts: [
        { type: "text", content: "Checking the register" },
        {
          type: "tool-call",
          id: "call-1",
          name: "list_templates",
          state: "complete",
          output: { templates: [] },
        },
        { type: "text", content: "Two found." },
      ],
      status: "finished",
    });
    expect(answerEntry(answer, "2026-10-20T10:00:00.000Z")).toEqual({
      id: ANSWER_ID,
      role: "assistant",
      createdAt: "2026-10-20T10:00:00.000Z",
      text: "Checking the register\n\nTwo found.",
      blocks: [
        { type: "text", key: "0", markdown: "Checking the register" },
        {
          type: "steps",
          key: "1",
          steps: [{ type: "tool", label: "list_templates", status: "done" }],
          work: new Map([["research", 1]]),
        },
        { type: "text", key: "2", markdown: "Two found." },
      ],
      files: [],
      drafts: [],
    });
  });

  test("a step is running until its result comes back, and failed when the result says so", () => {
    // Up to the tool call's start: no result yet.
    const started = reduce(events.slice(0, 4));
    expect(answerEntry(started, "2026-10-20T10:00:00.000Z").blocks[1]).toEqual({
      type: "steps",
      key: "1",
      steps: [{ type: "tool", label: "list_templates", status: "running" }],
      work: new Map(),
    });
    const failed = applyChatEvent(started, {
      type: "TOOL_CALL_RESULT",
      toolCallId: "call-1",
      content: '{"error":"Unavailable"}',
    });
    expect(answerEntry(failed, "2026-10-20T10:00:00.000Z").blocks[1]).toEqual({
      type: "steps",
      key: "1",
      steps: [{ type: "tool", label: "list_templates", status: "failed" }],
      work: new Map(),
    });
    // A local agent's step that failed or was cancelled says so in the
    // result's state, not its content; the stored message keeps it errored.
    for (const content of ['{"status":"failed"}', '{"status":"interrupted"}']) {
      const errored = applyChatEvent(started, {
        type: "TOOL_CALL_RESULT",
        toolCallId: "call-1",
        content,
        state: "output-error",
      });
      expect(
        answerEntry(errored, "2026-10-20T10:00:00.000Z").blocks[1],
      ).toEqual({
        type: "steps",
        key: "1",
        steps: [{ type: "tool", label: "list_templates", status: "failed" }],
        work: new Map(),
      });
    }
  });

  test("a coding agent's subagent groups its steps while the answer arrives, as the stored answer does", () => {
    const subagentInput = {
      tool: "Agent",
      detail: { kind: "subagent", description: "Check the lease" },
    };
    const stepInput = { command: "rg lease", parentCallId: "agent" };
    const argumentDeltas = (args: string) => {
      const middle = Math.floor(args.length / 2);
      return [args.slice(0, middle), args.slice(middle)];
    };
    const stepsOf = (
      id: string,
      name: string,
      input: unknown,
    ): readonly unknown[] => [
      { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
      // A native step's arguments arrive whole; split, they read the same.
      ...argumentDeltas(JSON.stringify(input)).map((delta) => ({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        delta,
      })),
      { type: "TOOL_CALL_END", toolCallId: id },
    ];
    const result = (id: string) => ({
      type: "TOOL_CALL_RESULT",
      toolCallId: id,
      content: '{"status":"completed"}',
    });
    const answer = reduce(
      [
        ...stepsOf("agent", "harness_native_tool", subagentInput),
        ...stepsOf("step", "command_execution", stepInput),
        // Another tool's arguments are not kept.
        ...stepsOf("other", "list_templates", { query: "lease" }),
        result("step"),
        result("agent"),
      ].flatMap((event) => parseChatEvent(JSON.stringify(event)) ?? []),
    );
    expect(answer.parts).toEqual([
      {
        type: "tool-call",
        id: "agent",
        name: "harness_native_tool",
        state: "complete",
        input: subagentInput,
        output: { status: "completed" },
      },
      {
        type: "tool-call",
        id: "step",
        name: "command_execution",
        state: "complete",
        input: stepInput,
        output: { status: "completed" },
      },
      {
        type: "tool-call",
        id: "other",
        name: "list_templates",
        state: "input-streaming",
      },
    ]);
    expect(answerEntry(answer, "2026-10-20T10:00:00.000Z").blocks).toEqual([
      {
        type: "subagent",
        key: "subagent:agent",
        description: "Check the lease",
        agentType: null,
        status: "done",
        stepCount: 1,
        steps: [
          {
            type: "local",
            label: "command_execution",
            titleKind: null,
            subtitle: { type: "text", text: "rg lease" },
            status: "done",
          },
        ],
      },
      {
        type: "steps",
        key: "2",
        steps: [{ type: "tool", label: "list_templates", status: "running" }],
        work: new Map(),
      },
    ]);
  });

  test("a subagent still open when the run fails or is stopped reads as stopped, and one waiting for the person stays open", () => {
    const open = (
      id: string,
      name: string,
      input: unknown,
    ): readonly unknown[] => [
      { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
      { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(input) },
      { type: "TOOL_CALL_END", toolCallId: id },
    ];
    const statusAfter = (end: unknown) =>
      answerEntry(
        reduce(
          [
            ...open("agent", "harness_native_tool", {
              tool: "Agent",
              detail: { kind: "subagent", description: "Check the lease" },
            }),
            ...open("step", "command_execution", {
              command: "rg lease",
              parentCallId: "agent",
            }),
            end,
          ].flatMap((event) => parseChatEvent(JSON.stringify(event)) ?? []),
        ),
        "2026-10-20T10:00:00.000Z",
      ).blocks.flatMap((block) =>
        block.type === "subagent" ? [block.status] : [],
      );
    expect(
      statusAfter({ type: "RUN_ERROR", message: "Provider failed" }),
    ).toEqual(["interrupted"]);
    expect(
      statusAfter({ type: "RUN_FINISHED", outcome: { type: "cancelled" } }),
    ).toEqual(["interrupted"]);
    // The stored thread, read next, says what the turn waits for.
    expect(
      statusAfter({ type: "RUN_FINISHED", outcome: { type: "interrupt" } }),
    ).toEqual(["running"]);
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

  test("carries attached files after the text, and files alone without it", () => {
    const pdf = {
      name: "Lease.pdf",
      mimeType: "application/pdf",
      dataUrl: "data:application/pdf;base64,JVBERg==",
    };
    const filePart = {
      type: "document",
      source: {
        type: "url",
        value: "data:application/pdf;base64,JVBERg==",
        mimeType: "application/pdf",
      },
      metadata: { filename: "Lease.pdf" },
    };
    const withText = chatSendBody({
      anonymized: false,
      files: [pdf],
      matterId: undefined,
      messageId: MESSAGE_ID,
      runId: "run-1",
      text: "Summarise this",
      threadId: THREAD_ID,
    });
    expect(withText.forwardedProps.message.parts).toEqual([
      { type: "text", content: "Summarise this" },
      filePart,
    ]);
    expect(withText.data).toEqual(withText.forwardedProps);
    // The envelope names the message; the file goes up once per copy of
    // the forwarded input, not again here.
    expect(withText.messages).toEqual([
      { id: MESSAGE_ID, role: "user", content: "Summarise this" },
    ]);
    expect(
      chatSendBody({
        anonymized: false,
        files: [pdf],
        matterId: undefined,
        messageId: MESSAGE_ID,
        runId: "run-1",
        text: "",
        threadId: THREAD_ID,
      }).forwardedProps.message.parts,
    ).toEqual([filePart]);
  });

  test("waits for a body with files to go up, within the longest upload", () => {
    expect(streamConnectTimeout(0)).toBe(20_000);
    expect(streamConnectTimeout(2000)).toBe(20_040);
    // A 10 MB file, encoded and carried twice, on a slow network.
    expect(streamConnectTimeout(28_000_000)).toBe(5 * 60_000);
    expect(streamConnectTimeout(5_000_000)).toBe(120_000);
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
    expect(textsOf(reduce(events))).toEqual([
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
    expect(textsOf(reduce(events))).toEqual(["Checking the "]);
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

test("stream and cancel requests propagate an unavailable session", async () => {
  const source = { ...sourceFor(), session: () => undefined };
  let requests = 0;
  const fetch: Fetch = async () => {
    requests += 1;
    return new Response(null, { status: 503 });
  };
  const joined = await joinChatTurn({
    fetch,
    source,
    lastEventId: "last-event",
    matterId: undefined,
    onEvent: () => {},
    signal: new AbortController().signal,
    threadId: THREAD_ID,
    turnId: TURN_ID,
  });
  expect(joined.isErr() ? joined.error.error._tag : joined.value).toBe(
    "SignedOutError",
  );
  expect(joined.isErr() ? joined.error.lastEventId : undefined).toBe(
    "last-event",
  );
  const cancelled = await cancelChatTurn({
    fetch,
    source,
    threadId: THREAD_ID,
    turnId: TURN_ID,
  });
  expect(cancelled.isErr() ? cancelled.error._tag : cancelled.value).toBe(
    "SignedOutError",
  );
  expect(requests).toBe(0);
});
