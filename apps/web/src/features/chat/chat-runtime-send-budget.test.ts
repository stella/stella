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
      },
      {
        id: `answer-${String(pair)}`,
        parts: [
          ...Array.from({ length: calls }, (_unused, call) => ({
            arguments: "{}",
            id: `call-${String(pair)}-${String(call)}`,
            name: "list_templates",
            output: { templates: [{ id: "template", name: "Template" }] },
            state: "complete",
            type: "tool-call",
          })),
          { content: `Answer ${String(pair)}`, type: "text" },
        ],
        role: "assistant",
      },
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
