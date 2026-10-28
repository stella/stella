import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

// What sending one message costs the network, whatever the thread holds: one
// request, the send itself, and a body that carries the message it posts.
// The server reads the thread's history from its own store and checks only
// that the envelope names the posted message (`hasEnvelopeCorrelationMismatch`
// in the API's send handler), so a page that loaded a long thread must not
// fetch it again first, nor upload it with every send.
//
// Calibration, measured on a 10-message thread and on a 500-message thread
// with 200 tool calls: the send body is 4,499 bytes for either (the posted
// message, twice as the envelope mirrors it, and the page's client tool
// definitions). Before the envelope dropped the mirrored history it was 5,074
// and 91,945 bytes. The budget adds about 14% for envelope fields the page
// adds with context (an active file, matters, a skill), never for history.

const SEND_BUDGET = {
  /** Requests the page makes to send one message. */
  requests: 1,
  /** Bytes of the send request's body. */
  bodyBytes: 5 * 1024,
  /**
   * Bytes of a continuation's body, which posts the answer being continued
   * (its tool call, input and result) and the resolved interrupts: 5,677 to
   * 6,235 bytes measured across approvals, ask-user answers, client tool
   * results and an edit-and-rerun, plus 15%.
   */
  continuationBodyBytes: 7 * 1024,
} as const;

const THREAD_ID = toChatThreadId("thread-send-budget");
const TURN_ID = "018f0000-0000-7000-8000-0000000000b1";
const encoder = new TextEncoder();

/** A thread the page has loaded: `messages` rows, with `toolCalls` calls
 *  spread evenly over its answers, each carrying a result. */
const loadedThread = ({
  messages,
  toolCalls,
}: {
  messages: number;
  toolCalls: number;
}): PersistedChatMessage[] => {
  const pairs = messages / 2;
  return Array.from({ length: pairs }, (_, pair) => {
    const calls =
      Math.floor(((pair + 1) * toolCalls) / pairs) -
      Math.floor((pair * toolCalls) / pairs);
    return [
      {
        id: `question-${String(pair)}`,
        parts: [{ content: `Question ${String(pair)}`, type: "text" }],
        role: "user",
      } satisfies PersistedChatMessage,
      {
        id: `answer-${String(pair)}`,
        parts: [
          ...Array.from(
            { length: calls },
            (_unused, call) =>
              ({
                arguments: "{}",
                id: `call-${String(pair)}-${String(call)}`,
                name: "list_templates",
                output: {
                  templates: [{ id: "template", name: "Template" }],
                },
                state: "complete",
                type: "tool-call",
              }) satisfies PersistedChatMessage["parts"][number],
          ),
          { content: `Answer ${String(pair)}`, type: "text" },
        ],
        role: "assistant",
      } satisfies PersistedChatMessage,
    ] satisfies PersistedChatMessage[];
  }).flat();
};

type ServedRequest = { bodyBytes: number; method: string; path: string };

const previousFetch = globalThis.fetch;

/** Answers every send with a short finished turn and records each request. */
const installServer = (): ServedRequest[] => {
  const served: ServedRequest[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const url = new URL(input instanceof Request ? input.url : input);
      const body = init?.body;
      served.push({
        bodyBytes:
          typeof body === "string" ? encoder.encode(body).byteLength : 0,
        method: init?.method ?? "GET",
        path: url.pathname,
      });
      const runId = `run-${TURN_ID}`;
      const events = [
        { runId, threadId: THREAD_ID, type: "RUN_STARTED" },
        { messageId: "reply", role: "assistant", type: "TEXT_MESSAGE_START" },
        { delta: "Done", messageId: "reply", type: "TEXT_MESSAGE_CONTENT" },
        { messageId: "reply", type: "TEXT_MESSAGE_END" },
        {
          finishReason: "stop",
          runId,
          threadId: THREAD_ID,
          type: "RUN_FINISHED",
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
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
  return served;
};

const sendOnLoadedThread = async (
  initialMessages: PersistedChatMessage[],
): Promise<ServedRequest[]> => {
  const served = installServer();
  const errors: Error[] = [];
  const runtime = createChatRuntime({
    activeTurnId: null,
    context: undefined,
    initialMessages,
    key: { scope: "global", threadId: THREAD_ID },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
    reloadThread: () => undefined,
  });
  await sendThreadChatMessage(runtime, {
    content: "One more question",
    id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-0000000000c1"),
  });
  runtime.leave();
  expect(errors).toEqual([]);
  return served;
};

describe("sending a message on a loaded thread", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("costs one bounded request, however long the thread is", async () => {
    const short = loadedThread({ messages: 10, toolCalls: 0 });
    const long = loadedThread({ messages: 500, toolCalls: 200 });
    // The long thread is what an N+1 or a history upload would pay for.
    expect(JSON.stringify(long).length).toBeGreaterThan(
      SEND_BUDGET.bodyBytes * 10,
    );
    const measured = {
      long: await sendOnLoadedThread(long),
      short: await sendOnLoadedThread(short),
    };
    const report = JSON.stringify({ budget: SEND_BUDGET, measured });
    for (const served of [measured.short, measured.long]) {
      expect(
        served.map(({ method, path }) => `${method} ${path}`),
        report,
      ).toEqual(["POST /v1/chat"]);
      expect(served.length, report).toBeLessThanOrEqual(SEND_BUDGET.requests);
      for (const { bodyBytes } of served) {
        expect(bodyBytes, report).toBeLessThanOrEqual(SEND_BUDGET.bodyBytes);
      }
    }
    // The body carries the posted message, not the thread: the same bytes
    // for a thread of ten messages and one of five hundred.
    expect(measured.long.at(0)?.bodyBytes, report).toBe(
      measured.short.at(0)?.bodyBytes,
    );
  });
});

// Every kind of send the page makes, on a long loaded thread. The server reads
// what it acts on from `forwardedProps` (the posted message, the run, the
// continuation's `parentRunId` and `resume`, `turnIntent`,
// `truncateAfterMessageId`), which the page builds from its whole message
// list. From the AG-UI envelope it reads only the correlation: the same
// thread, run, `parentRunId` and `resume`, Stella fields only in `forwardedProps`,
// and an envelope message with the posted message's id and role
// (`hasEnvelopeCorrelationMismatch` in the API's send handler). Each kind must
// pass that check with an envelope carrying the posted message alone.

/** A JSON object read from a request, for its fields' assertions. */
type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectAt = (value: JsonObject, key: string): JsonObject => {
  const field = value[key];
  if (!isJsonObject(field)) {
    throw new TypeError(`Expected ${key} to be an object`);
  }
  return field;
};

const ANCHOR_ROLES = new Set(["assistant", "system", "user"]);

/**
 * The send handler's envelope correlation, applied to a posted body, and
 * what the envelope carries besides the posted message.
 */
const correlationOf = (body: JsonObject) => {
  const forwarded = objectAt(body, "forwardedProps");
  const message = objectAt(forwarded, "message");
  const envelope = Array.isArray(body["messages"]) ? body["messages"] : [];
  const anchors = envelope.filter(
    (entry): entry is JsonObject =>
      isJsonObject(entry) && ANCHOR_ROLES.has(String(entry["role"])),
  );
  return {
    anchors: anchors.map(
      (anchor) => `${String(anchor["role"])} ${String(anchor["id"])}`,
    ),
    matches:
      body["threadId"] === forwarded["threadId"] &&
      body["runId"] === forwarded["runId"] &&
      body["parentRunId"] === forwarded["parentRunId"] &&
      JSON.stringify(body["resume"]) === JSON.stringify(forwarded["resume"]) &&
      !("data" in body) &&
      anchors.some(
        (anchor) =>
          anchor["id"] === message["id"] && anchor["role"] === message["role"],
      ),
    posted: `${String(message["role"])} ${String(message["id"])}`,
  };
};

const ASSISTANT_ID = "018f0000-0000-7000-8000-0000000000d1";

type ServerEvent = Record<string, unknown>;

const textAnswer = (runId: string): ServerEvent[] => [
  { runId, threadId: THREAD_ID, type: "RUN_STARTED" },
  { messageId: ASSISTANT_ID, role: "assistant", type: "TEXT_MESSAGE_START" },
  { delta: "Done", messageId: ASSISTANT_ID, type: "TEXT_MESSAGE_CONTENT" },
  { messageId: ASSISTANT_ID, type: "TEXT_MESSAGE_END" },
  { finishReason: "stop", runId, threadId: THREAD_ID, type: "RUN_FINISHED" },
];

const toolCallEvents = (
  toolCallId: string,
  toolName: string,
  input: JsonObject,
): ServerEvent[] => [
  {
    parentMessageId: ASSISTANT_ID,
    toolCallId,
    toolCallName: toolName,
    toolName,
    type: "TOOL_CALL_START",
  },
  { delta: JSON.stringify(input), toolCallId, type: "TOOL_CALL_ARGS" },
  {
    input,
    toolCallId,
    toolCallName: toolName,
    toolName,
    type: "TOOL_CALL_END",
  },
];

const APPROVAL_CALL_ID = "call-approval";
const APPROVAL_INPUT = { name: "Employment terms" };

/** A turn that ends waiting for the user to approve a server tool. */
const approvalAnswer = (runId: string): ServerEvent[] => [
  { runId, threadId: THREAD_ID, type: "RUN_STARTED" },
  ...toolCallEvents(APPROVAL_CALL_ID, "save_playbook", APPROVAL_INPUT),
  {
    finishReason: "tool_calls",
    outcome: {
      interrupts: [
        {
          id: `approval_${APPROVAL_CALL_ID}`,
          metadata: {
            input: APPROVAL_INPUT,
            kind: "approval",
            "tanstack:interruptBinding": {
              approvalSchemaHash: "server-owned",
              generation: 0,
              inputSchemaHash: "server-owned",
              interruptId: `approval_${APPROVAL_CALL_ID}`,
              interruptedRunId: runId,
              kind: "tool-approval",
              originalArgs: APPROVAL_INPUT,
              responseSchemaHash: "server-owned",
              toolCallId: APPROVAL_CALL_ID,
              toolName: "save_playbook",
              v: 1,
            },
            toolName: "save_playbook",
          },
          reason: "tool_call",
          toolCallId: APPROVAL_CALL_ID,
        },
      ],
      type: "interrupt",
    },
    runId,
    threadId: THREAD_ID,
    type: "RUN_FINISHED",
  },
];

/** A turn that ends handing the page a client tool to run: the ask-user
 *  card, or a drafted document. */
const clientToolAnswer =
  (toolCallId: string, toolName: string, input: JsonObject) =>
  (runId: string): ServerEvent[] => [
    { runId, threadId: THREAD_ID, type: "RUN_STARTED" },
    ...toolCallEvents(toolCallId, toolName, input),
    {
      finishReason: "tool_calls",
      outcome: {
        interrupts: [
          {
            id: `client_tool_${toolCallId}`,
            message: `Client tool ${toolName} is ready to run`,
            metadata: {
              input,
              kind: "client_tool",
              "tanstack:interruptBinding": {
                generation: 0,
                interruptId: `client_tool_${toolCallId}`,
                interruptedRunId: runId,
                kind: "client-tool-execution",
                outputSchemaHash: "server-owned",
                responseSchemaHash: "server-owned",
                toolCallId,
                toolName,
                v: 1,
              },
              toolName,
            },
            reason: "tanstack:client_tool_execution",
            responseSchema: {},
            toolCallId,
          },
        ],
        type: "interrupt",
      },
      runId,
      threadId: THREAD_ID,
      type: "RUN_FINISHED",
    },
  ];

const ASK_CALL_ID = "call-ask";
const ASK_INPUT = {
  questions: [{ question: "Which side?", reason: "It decides the draft." }],
};
const ASK_ANSWER = { answers: [{ answer: "Buyer", question: "Which side?" }] };
const DRAFT_CALL_ID = "call-draft";
const DRAFT_INPUT = { name: "NDA", source: "@title NDA" };
const DRAFT_RESULT = {
  destination: "download",
  fileName: "NDA.docx",
  success: true,
};

/**
 * A page on the long thread whose server answers its requests in order with
 * `answers`, recording each posted body.
 */
const openScriptedPage = (
  answers: readonly ((runId: string) => ServerEvent[])[],
) => {
  const posted: { body: JsonObject; bytes: number }[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const text = typeof init?.body === "string" ? init.body : "{}";
      const body: unknown = JSON.parse(text);
      if (!isJsonObject(body)) {
        throw new TypeError("Expected a JSON request body");
      }
      posted.push({ body, bytes: encoder.encode(text).byteLength });
      const answer =
        answers[posted.length - 1] ??
        expect.unreachable(`Unscripted request ${String(posted.length)}`);
      return new Response(
        answer(String(body["runId"]))
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
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
  const errors: Error[] = [];
  const runtime = createChatRuntime({
    activeTurnId: null,
    context: undefined,
    initialMessages: loadedThread({ messages: 500, toolCalls: 200 }),
    key: { scope: "global", threadId: THREAD_ID },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
    reloadThread: () => undefined,
  });
  return { errors, posted, runtime };
};

const QUESTION_ID = toSafeId<"chatMessage">(
  "018f0000-0000-7000-8000-0000000000e1",
);

const askQuestion = async (runtime: ReturnType<typeof createChatRuntime>) => {
  await sendThreadChatMessage(runtime, {
    content: "Draft the agreement",
    id: QUESTION_ID,
  });
};

/** Every posted body passes the server's correlation with an envelope of
 *  the posted message alone, posting `expected` in order. */
const expectEachSendPosts = (
  page: ReturnType<typeof openScriptedPage>,
  expected: readonly string[],
) => {
  const correlations = page.posted.map(({ body }) => correlationOf(body));
  const report = JSON.stringify({
    correlations,
    bytes: page.posted.map(({ bytes }) => bytes),
    errors: page.errors.map(({ message }) => message),
  });
  expect(page.errors, report).toEqual([]);
  expect(
    correlations.map(({ posted }) => posted),
    report,
  ).toEqual([...expected]);
  for (const correlation of correlations) {
    expect(correlation.matches, report).toBe(true);
    expect(correlation.anchors, report).toEqual([correlation.posted]);
  }
  for (const [index, { bytes }] of page.posted.entries()) {
    expect(bytes, report).toBeLessThanOrEqual(
      correlations[index]?.posted.startsWith("assistant ") === true
        ? SEND_BUDGET.continuationBodyBytes
        : SEND_BUDGET.bodyBytes,
    );
  }
  page.runtime.leave();
};

describe("every kind of send carries only the message it posts", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("a new message", async () => {
    const page = openScriptedPage([textAnswer]);
    await askQuestion(page.runtime);
    expectEachSendPosts(page, [`user ${QUESTION_ID}`]);
  });

  test("regenerating the latest answer", async () => {
    const page = openScriptedPage([textAnswer, textAnswer]);
    await askQuestion(page.runtime);
    await page.runtime.reload();
    expectEachSendPosts(page, [`user ${QUESTION_ID}`, `user ${QUESTION_ID}`]);
    expect(
      objectAt(page.posted.at(1)?.body ?? {}, "forwardedProps")["turnIntent"],
    ).toBe("regenerate");
  });

  test("approving or denying a tool call", async () => {
    for (const approved of [true, false]) {
      const page = openScriptedPage([approvalAnswer, textAnswer]);
      await askQuestion(page.runtime);
      await page.runtime.resolveToolApproval({
        approved,
        id: `approval_${APPROVAL_CALL_ID}`,
      });
      expectEachSendPosts(page, [
        `user ${QUESTION_ID}`,
        `assistant ${ASSISTANT_ID}`,
      ]);
      expect(
        objectAt(page.posted.at(1)?.body ?? {}, "forwardedProps"),
      ).toMatchObject({
        parentRunId: page.posted.at(0)?.body["runId"],
        resume: [
          {
            interruptId: `approval_${APPROVAL_CALL_ID}`,
            payload: { approved },
            status: "resolved",
          },
        ],
      });
      resetChatRequestStateForTests();
    }
  });

  test("answering an ask-user card", async () => {
    const page = openScriptedPage([
      clientToolAnswer(ASK_CALL_ID, "ask-user", ASK_INPUT),
      textAnswer,
    ]);
    await askQuestion(page.runtime);
    await page.runtime.addToolResult({
      output: ASK_ANSWER,
      tool: "ask-user",
      toolCallId: ASK_CALL_ID,
    });
    expectEachSendPosts(page, [
      `user ${QUESTION_ID}`,
      `assistant ${ASSISTANT_ID}`,
    ]);
    expect(
      objectAt(page.posted.at(1)?.body ?? {}, "forwardedProps"),
    ).toMatchObject({
      parentRunId: page.posted.at(0)?.body["runId"],
      resume: [
        { interruptId: `client_tool_${ASK_CALL_ID}`, status: "resolved" },
      ],
    });
  });

  test("returning a client tool's result", async () => {
    const page = openScriptedPage([
      clientToolAnswer(DRAFT_CALL_ID, "create-document", DRAFT_INPUT),
      textAnswer,
    ]);
    await askQuestion(page.runtime);
    await page.runtime.addToolResult({
      output: DRAFT_RESULT,
      tool: "create-document",
      toolCallId: DRAFT_CALL_ID,
    });
    expectEachSendPosts(page, [
      `user ${QUESTION_ID}`,
      `assistant ${ASSISTANT_ID}`,
    ]);
    expect(
      objectAt(page.posted.at(1)?.body ?? {}, "forwardedProps"),
    ).toMatchObject({
      parentRunId: page.posted.at(0)?.body["runId"],
      resume: [
        { interruptId: `client_tool_${DRAFT_CALL_ID}`, status: "resolved" },
      ],
    });
  });

  test("editing an ask-user answer and rerunning from it", async () => {
    const page = openScriptedPage([
      clientToolAnswer(ASK_CALL_ID, "ask-user", ASK_INPUT),
      textAnswer,
      textAnswer,
    ]);
    await askQuestion(page.runtime);
    await page.runtime.addToolResult({
      output: ASK_ANSWER,
      tool: "ask-user",
      toolCallId: ASK_CALL_ID,
    });
    // As the page's edit-and-rerun does (`handleAskUserEditAndRerun`): drop
    // everything after the card's message, reset the card, answer again.
    const messages = page.runtime.getSnapshot().messages;
    const target = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) => part.type === "tool-call" && part.id === ASK_CALL_ID,
        ),
    );
    expect(target).toBeGreaterThan(0);
    page.runtime.setMessages(
      messages.slice(0, target + 1).map((message, index) =>
        index !== target
          ? message
          : {
              ...message,
              parts: message.parts.flatMap((part) => {
                if (
                  part.type === "tool-result" &&
                  part.toolCallId === ASK_CALL_ID
                ) {
                  return [];
                }
                if (part.type === "tool-call" && part.id === ASK_CALL_ID) {
                  const { output: _discarded, ...rest } = part;
                  return [{ ...rest, state: "input-complete" as const }];
                }
                return [part];
              }),
            },
      ),
    );
    const targetId = messages[target]?.id ?? expect.unreachable("No target");
    await page.runtime.addToolResult(
      {
        output: { answers: [{ answer: "Seller", question: "Which side?" }] },
        tool: "ask-user",
        toolCallId: ASK_CALL_ID,
      },
      { body: { truncateAfterMessageId: toSafeId<"chatMessage">(targetId) } },
    );
    expectEachSendPosts(page, [
      `user ${QUESTION_ID}`,
      `assistant ${ASSISTANT_ID}`,
      `assistant ${targetId}`,
    ]);
    expect(
      objectAt(page.posted.at(2)?.body ?? {}, "forwardedProps")[
        "truncateAfterMessageId"
      ],
    ).toBe(targetId);
  });

  test("a new message on a thread whose last answer was stopped", async () => {
    const page = openScriptedPage([textAnswer]);
    // A stopped turn reloads the page; its partial answer is the thread's
    // last message.
    page.runtime.setMessages([
      ...page.runtime.getSnapshot().messages,
      {
        id: "stopped-answer",
        parts: [{ content: "Drafting", type: "text" }],
        role: "assistant",
      },
    ]);
    await askQuestion(page.runtime);
    expectEachSendPosts(page, [`user ${QUESTION_ID}`]);
  });
});
