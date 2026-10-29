import type { UIMessage } from "@tanstack/ai-client";
import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { chatRefusal } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

// The session behind a chat page ends while an answer streams: it is revoked
// from another device, or it expires while the laptop sleeps. The page learns
// it when its connection drops and the reconnect is refused. It must stop at
// that first refusal, keep everything it already showed, and say the session
// ended (sign in again), not report a failed send or missing permissions.

const THREAD_ID = toChatThreadId("thread-session-ended");
const TURN_ID = toSafeId<"chatTurn">("018f0000-0000-7000-8000-0000000000e1");
const RUN_ID = "run-session-ended";
const ANSWER_ID = "answer-session-ended";
const USER_TEXT = "Summarise the lease";
const PARTIAL_ANSWER = "The lease runs";
const encoder = new TextEncoder();

/** What the server refuses a reconnect with once the session is gone, and
 *  for contrast, once the session lives but has lost access. */
const REFUSALS = [
  { status: 401, body: { message: "Unauthorized" } },
  { status: 403, body: { message: "Forbidden" } },
] as const;

const answerEvents = [
  { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
  { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: ANSWER_ID, delta: "The lease" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: ANSWER_ID, delta: " runs" },
];

/** A durable answer stream (each event carries its run-log offset) whose
 *  connection drops before the run finishes. */
const droppedAnswerStream = (headers: Record<string, string> = {}) => {
  let position = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const event = answerEvents.at(position);
        if (event === undefined) {
          controller.error(new TypeError("Connection dropped"));
          return;
        }
        controller.enqueue(
          encoder.encode(
            `id: ${position + 1}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
        position += 1;
      },
    }),
    { headers: { "Content-Type": "text/event-stream", ...headers } },
  );
};

type Server = {
  /** Every request the page sent, as `METHOD action`, in order. */
  log: string[];
};

const requestAction = (input: RequestInfo | URL): string => {
  const url = new URL(input instanceof Request ? input.url : input);
  return url.pathname.split("/").at(-1) ?? "";
};

/**
 * The API once the session has ended mid-answer. `firstAnswer` serves the
 * stream the page opened while it was still signed in; every later request
 * is refused with `refusal`, as the auth layer refuses a session it no longer
 * knows.
 */
const installServer = ({
  firstAnswer,
  refusal,
}: {
  firstAnswer: "join" | "send";
  refusal: (typeof REFUSALS)[number];
}): Server => {
  const server: Server = { log: [] };
  let served = false;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const action = requestAction(input);
      server.log.push(`${init?.method ?? "GET"} ${action}`);
      if (!served && firstAnswer === "send" && action === "chat") {
        served = true;
        return droppedAnswerStream({ [CHAT_TURN_ID_HEADER]: TURN_ID });
      }
      if (!served && firstAnswer === "join") {
        if (action === "resume") {
          return Response.json({
            type: "running",
            turnId: TURN_ID,
            runId: RUN_ID,
          });
        }
        if (action === "join") {
          served = true;
          return droppedAnswerStream();
        }
      }
      return Response.json(refusal.body, { status: refusal.status });
    },
    { preconnect: () => undefined },
  );
  return server;
};

type Page = { errors: Error[]; reloads: () => number; runtime: ChatRuntime };

const openPage = ({
  activeTurnId,
  initialMessages,
}: {
  activeTurnId: typeof TURN_ID | null;
  initialMessages: PersistedChatMessage[];
}): Page => {
  const errors: Error[] = [];
  let reloads = 0;
  const runtime = createChatRuntime({
    activeTurnId,
    context: undefined,
    initialMessages,
    key: { scope: "global", threadId: THREAD_ID },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
    reloadThread: () => {
      reloads += 1;
    },
  });
  return { errors, reloads: () => reloads, runtime };
};

/** Resolves once the page has stopped working on its request: the change
 *  that ends it reaches the runtime's subscribers at once. */
const settle = async (runtime: ChatRuntime) => {
  const stopped = () => {
    const snapshot = runtime.getSnapshot();
    return (
      !snapshot.isLoading &&
      !snapshot.reconnecting &&
      snapshot.error !== undefined
    );
  };
  if (stopped()) {
    return;
  }
  const done = Promise.withResolvers<undefined>();
  const unsubscribe = runtime.subscribe(() => {
    if (stopped()) {
      done.resolve(undefined);
    }
  });
  try {
    await done.promise;
  } finally {
    unsubscribe();
  }
};

const textOf = (messages: readonly UIMessage[], role: UIMessage["role"]) =>
  messages
    .filter((message) => message.role === role)
    .flatMap(({ parts }) =>
      parts.flatMap((part) => (part.type === "text" ? [part.content] : [])),
    )
    .join("");

const previousFetch = globalThis.fetch;

describe("a chat page whose session ends while an answer streams", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  for (const refusal of REFUSALS) {
    test(`a ${refusal.status} reconnect after a dropped send stops at once and keeps the transcript`, async () => {
      const server = installServer({ firstAnswer: "send", refusal });
      const page = openPage({ activeTurnId: null, initialMessages: [] });
      const unsubscribe = page.runtime.subscribe(() => undefined);
      try {
        const sent = Result.tryPromise(
          async () =>
            await sendThreadChatMessage(page.runtime, {
              content: USER_TEXT,
              id: toSafeId<"chatMessage">(
                "018f0000-0000-7000-8000-0000000000e2",
              ),
            }),
        );
        await settle(page.runtime);
        await sent;
        const snapshot = page.runtime.getSnapshot();

        // One send, then exactly one reconnect probe that was refused.
        expect(server.log).toEqual(["POST chat", "GET resume"]);
        expect(page.reloads()).toBe(0);
        expect(snapshot).toMatchObject({
          isLoading: false,
          reconnecting: false,
        });
        // What the page already showed stays: the question and the part of
        // the answer that arrived before the connection dropped.
        expect(textOf(snapshot.messages, "user")).toBe(USER_TEXT);
        expect(textOf(snapshot.messages, "assistant")).toBe(PARTIAL_ANSWER);
        // The refusal reaches the page as the server's answer, so an ended
        // session reads as "sign in again" and lost access as forbidden.
        expect(chatRefusal(snapshot.error)?.status).toBe(refusal.status);
      } finally {
        unsubscribe();
      }
    });

    test(`a ${refusal.status} reconnect while rejoining a running turn stops at once and keeps the transcript`, async () => {
      const server = installServer({ firstAnswer: "join", refusal });
      const page = openPage({
        activeTurnId: TURN_ID,
        initialMessages: [
          {
            id: "question",
            role: "user",
            parts: [{ type: "text", content: USER_TEXT }],
          },
        ],
      });
      const unsubscribe = page.runtime.subscribe(() => undefined);
      try {
        await settle(page.runtime);
        const snapshot = page.runtime.getSnapshot();

        // The loader's probe, the join's own probe and the join, then one
        // refused reconnect probe.
        expect(server.log).toEqual([
          "GET resume",
          "GET resume",
          "GET join",
          "GET resume",
        ]);
        expect(page.reloads()).toBe(0);
        expect(snapshot).toMatchObject({
          isLoading: false,
          reconnecting: false,
        });
        expect(textOf(snapshot.messages, "user")).toBe(USER_TEXT);
        expect(textOf(snapshot.messages, "assistant")).toBe(PARTIAL_ANSWER);
        expect(chatRefusal(snapshot.error)?.status).toBe(refusal.status);
      } finally {
        unsubscribe();
      }
    });
  }
});
