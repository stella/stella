/* oxlint-disable require-contract-domains/require-contract-domains -- Generator sizes bound the test workload; they are not an API limit. */
import { EventType } from "@tanstack/ai";
import { Result } from "better-result";
import type { UnhandledException } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

// A page loaded before a deploy keeps streaming from the server deployed after
// it. Whatever the newer server adds to the stream, an event type or a field
// the page's SDK does not know, the page skips it: the turn reads and ends
// exactly as the same stream without the additions.

const THREAD_ID = toChatThreadId("thread-version-skew");
const RUN_ID = "run-version-skew";
const ANSWER_ID = "22222222-2222-4222-8222-222222222222";
const REASONING_ID = "33333333-3333-4333-8333-333333333333";

type StreamEvent = Record<string, unknown> & { type: string };

/** A complete turn the current server streams: reasoning, then an answer. */
const CURRENT_TURN: readonly StreamEvent[] = [
  { runId: RUN_ID, threadId: THREAD_ID, type: EventType.RUN_STARTED },
  {
    messageId: REASONING_ID,
    role: "reasoning",
    type: EventType.REASONING_MESSAGE_START,
  },
  {
    delta: "Weigh the clause. ",
    messageId: REASONING_ID,
    type: EventType.REASONING_MESSAGE_CONTENT,
  },
  { messageId: REASONING_ID, type: EventType.REASONING_MESSAGE_END },
  {
    messageId: ANSWER_ID,
    role: "assistant",
    type: EventType.TEXT_MESSAGE_START,
  },
  ...["The ", "NDA ", "is ", "mutual."].map((delta) => ({
    delta,
    messageId: ANSWER_ID,
    type: EventType.TEXT_MESSAGE_CONTENT,
  })),
  { messageId: ANSWER_ID, type: EventType.TEXT_MESSAGE_END },
  { runId: RUN_ID, threadId: THREAD_ID, type: EventType.RUN_FINISHED },
];

const KNOWN_EVENT_TYPES = new Set<string>(Object.values(EventType));

/** Every field name the protocol already gives meaning to: an addition the
 *  page has to skip is one it cannot read as something it knows. */
const PROTOCOL_FIELDS = new Set<string>([
  ...CURRENT_TURN.flatMap((event) => Object.keys(event)),
  "metadata",
  "subagentRunId",
  "timestamp",
]);

const futureFieldName = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((name) => !PROTOCOL_FIELDS.has(name));

const futureFields = fc.dictionary(futureFieldName, fc.jsonValue(), {
  maxKeys: 3,
});

/** Event type names a newer server may send. Names an object already carries
 *  from its prototype stand in for any lookup a client keys by event type. */
const futureEventType = fc
  .oneof(
    fc.stringMatching(/^[A-Z][A-Z_]{2,24}$/u),
    fc.constantFrom(...Object.getOwnPropertyNames(Object.prototype)),
    fc.string({ minLength: 1, maxLength: 16 }),
  )
  .filter((type) => !KNOWN_EVENT_TYPES.has(type));

const futureEvent = fc.record({
  fields: futureFields,
  type: futureEventType,
});

type Addition = {
  /** Fields a newer server adds to each event the page knows. */
  fieldsByEvent: Record<string, unknown>[];
  /** Events of unknown types, each before the event at `before`. */
  inserted: { before: number; event: { fields: object; type: string } }[];
};

const addition: fc.Arbitrary<Addition> = fc.record({
  fieldsByEvent: fc.array(futureFields, {
    minLength: CURRENT_TURN.length,
    maxLength: CURRENT_TURN.length,
  }),
  inserted: fc.array(
    fc.record({
      before: fc.integer({ min: 0, max: CURRENT_TURN.length - 1 }),
      event: futureEvent,
    }),
    { minLength: 1, maxLength: 6 },
  ),
});

/** The current turn as a newer server streams it. The last event stays the
 *  run's end, so every unknown event arrives while the turn is open. */
const streamedByNewerServer = ({
  fieldsByEvent,
  inserted,
}: Addition): StreamEvent[] =>
  CURRENT_TURN.flatMap((event, index) => [
    ...inserted
      .filter(({ before }) => before === index)
      .map(({ event: future }) => ({ ...future.fields, type: future.type })),
    { ...fieldsByEvent[index], ...event },
  ]);

const previousFetch = globalThis.fetch;
const encoder = new TextEncoder();

/** Answers the page's chat request with `events`, then closes the stream. */
const serve = (events: readonly StreamEvent[]) => {
  globalThis.fetch = Object.assign(
    async () => {
      await Promise.resolve();
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          }
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    { preconnect: previousFetch.preconnect },
  );
};

type Turn = {
  errors: Error[];
  sent: Result<void, UnhandledException>;
  snapshot: ReturnType<ChatRuntime["getSnapshot"]>;
};

/** The page sends one message and reads the response `events` to its end. */
const readTurn = async (events: readonly StreamEvent[]): Promise<Turn> => {
  resetChatRequestStateForTests();
  serve(events);
  const errors: Error[] = [];
  const runtime = createChatRuntime({
    activeTurnId: null,
    context: undefined,
    initialMessages: [],
    key: { scope: "global", threadId: THREAD_ID },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => {},
    reloadThread: () => {},
    scheduleEmit: (callback) => {
      const timer = setTimeout(callback, 0);
      return () => {
        clearTimeout(timer);
      };
    },
  });
  const sent = await Result.tryPromise(
    async () =>
      await sendThreadChatMessage(runtime, {
        content: "Is the NDA mutual?",
        id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000011"),
      }),
  );
  const snapshot = runtime.getSnapshot();
  runtime.leave();
  return { errors, sent, snapshot };
};

/** What the reader sees of a turn: who said what, part by part. */
const transcript = ({ snapshot }: Turn) =>
  snapshot.messages.map(({ parts, role }) => ({ parts, role }));

describe("a page streaming from a newer server", () => {
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("the current turn reads to its end", async () => {
    const turn = await readTurn(CURRENT_TURN);
    expect(turn.sent).toEqual(Result.ok(undefined));
    expect(turn.errors).toEqual([]);
    expect(turn.snapshot.status).toBe("ready");
    const answer = turn.snapshot.messages.at(-1);
    expect(answer?.role).toBe("assistant");
    expect(answer?.parts).toContainEqual(
      expect.objectContaining({ type: "text", content: "The NDA is mutual." }),
    );
    expect(answer?.parts).toContainEqual(
      expect.objectContaining({
        type: "thinking",
        content: "Weigh the clause. ",
      }),
    );
  });

  test("skips event types and fields it does not know, and the turn reads and ends as without them", async () => {
    const current = transcript(await readTurn(CURRENT_TURN));
    await assertProperty(
      "skips event types and fields it does not know, and the turn reads and ends as without them",
      fc.asyncProperty(addition, async (added) => {
        const streamed = streamedByNewerServer(added);
        // The fixture reaches the boundary: the page receives types its SDK
        // has no name for.
        expect(
          streamed.some((event) => !KNOWN_EVENT_TYPES.has(event.type)),
        ).toBe(true);
        const turn = await readTurn(streamed);
        expect(turn.sent).toEqual(Result.ok(undefined));
        expect(turn.errors).toEqual([]);
        expect(turn.snapshot.error).toBeUndefined();
        expect(turn.snapshot.status).toBe("ready");
        expect(transcript(turn)).toEqual(current);
      }),
      { numRuns: 40 },
    );
  });
});
