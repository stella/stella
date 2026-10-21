import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import type { RunAgentInputContext, UIMessage } from "@tanstack/ai-client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { sleep } from "@stll/concurrency/sleep";
import { assertProperty } from "@stll/property-testing";

import { projectCanonicalChatUIMessages } from "@/components/chat/chat-ui-tools";
import type {
  ChatClientTools,
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { toPersistedChatMessages } from "@/features/chat/chat-persisted-messages";
import { keepShownRejoinMessages } from "@/features/chat/chat-rejoin-messages";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import {
  keepPostedMessages,
  keepReasoningSteps,
} from "@/features/chat/chat-snapshot-history";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

// A memoized message row or part card skips a render only when the chunk
// leaves its object as it was. These tests drive the SDK client the runtime
// uses and project its messages the way the page does, then check that a
// chunk replaces only what it changed and costs nothing for the rest.

const ANSWER_ID = "answer";
const TOOL_NAME = "mcp__records__lookup";

/** The messages the page renders for one client emit: the runtime's
 *  projection, then the session's canonical check. */
const show = (messages: UIMessage<ChatClientTools>[]): ChatUIMessage[] =>
  projectCanonicalChatUIMessages(toPersistedChatMessages(messages));

type ToolCallOp = { args: string[]; result: boolean };
type AnswerOp =
  | { kind: "reasoning"; delta: string }
  | { kind: "status" }
  | { kind: "text"; delta: string }
  | { calls: ToolCallOp[]; kind: "tools" };

/** The chunks a run streams for `ops`, in protocol order. Parallel calls
 *  start together, interleave their arguments, then end and report. */
const answerChunks = (
  ops: readonly AnswerOp[],
  run: RunAgentInputContext,
): StreamChunk[] => {
  const chunks: StreamChunk[] = [
    { type: EventType.RUN_STARTED, runId: run.runId, threadId: run.threadId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: ANSWER_ID,
      role: "assistant",
    },
  ];
  let calls = 0;
  let steps = 0;
  for (const op of ops) {
    switch (op.kind) {
      case "text":
        chunks.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: ANSWER_ID,
          delta: op.delta,
        });
        break;
      case "reasoning":
        chunks.push({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: `reasoning-${String(steps)}`,
          delta: op.delta,
        });
        break;
      case "status":
        steps += 1;
        chunks.push(
          { type: EventType.STEP_STARTED, stepName: `step-${String(steps)}` },
          { type: EventType.STEP_FINISHED, stepName: `step-${String(steps)}` },
        );
        break;
      case "tools": {
        const first = calls;
        calls += op.calls.length;
        const started = op.calls.map((call, index) => ({
          ...call,
          id: `call-${String(first + index + 1)}`,
        }));
        for (const { id } of started) {
          chunks.push({
            type: EventType.TOOL_CALL_START,
            toolCallId: id,
            toolCallName: TOOL_NAME,
            parentMessageId: ANSWER_ID,
          });
        }
        const longest = Math.max(...started.map(({ args }) => args.length));
        for (let index = 0; index < longest; index += 1) {
          for (const { args, id } of started) {
            const delta = args.at(index);
            if (delta !== undefined) {
              chunks.push({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: id,
                delta,
              });
            }
          }
        }
        for (const { id } of started) {
          chunks.push({ type: EventType.TOOL_CALL_END, toolCallId: id });
        }
        for (const { id, result } of started) {
          if (result) {
            chunks.push({
              type: EventType.TOOL_CALL_RESULT,
              messageId: `result-${id}`,
              toolCallId: id,
              content: JSON.stringify({ rows: [id] }),
            });
          }
        }
        break;
      }
      default:
        op satisfies never;
    }
  }
  chunks.push(
    { type: EventType.TEXT_MESSAGE_END, messageId: ANSWER_ID },
    {
      type: EventType.RUN_FINISHED,
      runId: run.runId,
      threadId: run.threadId,
      finishReason: "stop",
    },
  );
  return chunks;
};

// Arbitrary sizes: small transcripts and answers keep each run fast while
// still mixing every part and chunk kind.
const MIN_ONE = 1;
const MAX_TEXT = 6;
const MAX_QUERY = 12;
const MAX_ARG_PIECES = 4;
const MAX_PARALLEL_CALLS = 4;
const MAX_TURN_PARTS = 6;
const MAX_TURNS = 4;
const MAX_ANSWER_OPS = 12;
const MAX_POSTED = 8;
const MAX_ADDED = 2;

/** Whitespace-only text is what the projection rewrites, so the arbitraries
 *  produce it often. */
const textArb = fc.oneof(
  fc.constantFrom(" ", "\n\n", "Clause", " 4.2", "café", "العربية"),
  fc.string({ maxLength: MAX_TEXT }),
);

/** Tool arguments split into the deltas a provider streams. */
const argsArb = fc
  .tuple(
    fc.string({ maxLength: MAX_QUERY }),
    fc.integer({ min: 1, max: MAX_ARG_PIECES }),
  )
  .map(([query, pieces]) => {
    const raw = JSON.stringify({ query });
    const size = Math.ceil(raw.length / pieces);
    return Array.from({ length: pieces }, (_, index) =>
      raw.slice(index * size, (index + 1) * size),
    ).filter((piece) => piece !== "");
  });

const answerOpArb: fc.Arbitrary<AnswerOp> = fc.oneof(
  textArb.map((delta) => ({ kind: "text" as const, delta })),
  textArb.map((delta) => ({ kind: "reasoning" as const, delta })),
  fc.constant({ kind: "status" as const }),
  fc
    .array(fc.record({ args: argsArb, result: fc.boolean() }), {
      minLength: MIN_ONE,
      maxLength: MAX_PARALLEL_CALLS,
    })
    .map((calls) => ({ kind: "tools" as const, calls })),
);

type FinishedPart = PersistedChatMessage["parts"][number];

const finishedCall = (id: string, query: string): FinishedPart[] => [
  {
    type: "tool-call",
    id,
    name: TOOL_NAME,
    arguments: JSON.stringify({ query }),
    input: { query },
    state: "complete",
    output: { rows: [query] },
  },
  {
    type: "tool-result",
    toolCallId: id,
    content: JSON.stringify({ rows: [query] }),
    state: "complete",
  },
];

/** A settled transcript of `turns`, each a question and an answer built
 *  from the given finished parts. */
const transcript = (
  turns: readonly (readonly FinishedPart[])[],
): PersistedChatMessage[] =>
  turns.flatMap((parts, turn) => [
    {
      id: `question-${String(turn)}`,
      role: "user" as const,
      parts: [{ type: "text" as const, content: `Question ${String(turn)}` }],
    },
    {
      id: `reply-${String(turn)}`,
      role: "assistant" as const,
      parts: [...parts],
    },
  ]);

type HistoryPart =
  | { content: string; kind: "text" | "thinking" }
  | { kind: "call"; query: string };

const historyArb = fc
  .array(
    fc.array(
      fc.oneof(
        fc.record({
          content: textArb,
          kind: fc.constantFrom("text" as const, "thinking" as const),
        }),
        fc.record({
          kind: fc.constant("call" as const),
          query: fc.string({ maxLength: MAX_QUERY }),
        }),
      ),
      { maxLength: MAX_TURN_PARTS },
    ),
    { maxLength: MAX_TURNS },
  )
  .map((turns: HistoryPart[][]) => {
    let calls = 0;
    return transcript(
      turns.map((parts) =>
        parts.flatMap((part): FinishedPart[] => {
          switch (part.kind) {
            case "text":
            case "thinking":
              return [{ type: part.kind, content: part.content }];
            case "call":
              calls += 1;
              return finishedCall(`history-call-${String(calls)}`, part.query);
            default:
              return part satisfies never;
          }
        }),
      ),
    );
  });

type Emit = { chunk: StreamChunk | undefined; shown: ChatUIMessage[] };

/** Streams `ops` through the SDK client and records what the page shows on
 *  every emit, with the chunk being processed. */
const streamAnswer = async ({
  history,
  ops,
  onMessages = show,
}: {
  history: PersistedChatMessage[];
  ops: readonly AnswerOp[];
  onMessages?: (messages: UIMessage<ChatClientTools>[]) => ChatUIMessage[];
}): Promise<Emit[]> => {
  const emits: Emit[] = [];
  let chunk: StreamChunk | undefined;
  const client = new ChatClient<ChatClientTools, unknown, readonly []>({
    initialMessages: history,
    connection: {
      async *connect(_messages, _data, _signal, run) {
        if (run === undefined) {
          throw new Error("The client omitted the run context");
        }
        yield* answerChunks(ops, run);
      },
    },
    onChunk: (next) => {
      chunk = next;
    },
    onMessagesChange: (messages) => {
      emits.push({ chunk, shown: onMessages(messages) });
    },
  });
  client.attach();
  try {
    await client.sendMessage("Find the records");
  } finally {
    client.detach();
  }
  return emits;
};

/** Whether `chunk` may replace `part`, a part the page showed before it. */
const chunkMayReplace = (
  chunk: StreamChunk | undefined,
  part: ChatUIMessage["parts"][number],
  parts: readonly ChatUIMessage["parts"][number][],
): boolean => {
  switch (chunk?.type) {
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_END:
    case EventType.RUN_FINISHED:
      // The streaming segment is the answer's last part.
      return part.type === "text" && part === parts.at(-1);
    case EventType.REASONING_MESSAGE_CONTENT:
      return part === parts.findLast(({ type }) => type === "thinking");
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_RESULT:
      return (
        (part.type === "tool-call" && part.id === chunk.toolCallId) ||
        (part.type === "tool-result" && part.toolCallId === chunk.toolCallId)
      );
    default:
      return false;
  }
};

describe("streamed chunks keep what they do not change", () => {
  test("every chunk leaves the messages and parts it does not touch as the same objects", async () => {
    await assertProperty(
      "every chunk leaves the messages and parts it does not touch as the same objects",
      fc.asyncProperty(
        historyArb,
        fc.array(answerOpArb, {
          minLength: MIN_ONE,
          maxLength: MAX_ANSWER_OPS,
        }),
        async (history, ops) => {
          const emits = await streamAnswer({ history, ops });
          for (const [index, next] of emits.entries()) {
            const previous = emits.at(index - 1);
            if (index === 0 || previous === undefined) {
              continue;
            }
            const before = new Map(
              previous.shown.map((message) => [message.id, message]),
            );
            for (const message of next.shown) {
              const shown = before.get(message.id);
              if (shown === undefined) {
                continue;
              }
              // The SDK's TOOL_CALL_RESULT handler (updateToolCallWithOutput)
              // copies every message object; their parts stay the same.
              if (
                message.id !== ANSWER_ID &&
                next.chunk?.type !== EventType.TOOL_CALL_RESULT
              ) {
                expect(message).toBe(shown);
              }
              const kept = new Set(message.parts);
              for (const part of shown.parts) {
                if (!kept.has(part)) {
                  expect({
                    chunk: next.chunk?.type,
                    message: message.id,
                    replaced: part,
                    allowed: chunkMayReplace(next.chunk, part, shown.parts),
                  }).toMatchObject({ allowed: true });
                }
              }
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  test("a chunk reads no part of the 200 finished tool calls it leaves alone", async () => {
    let counting = false;
    let reads = 0;
    const watched = <Part extends object>(part: Part): Part =>
      new Proxy(part, {
        get: (target, key, receiver) => {
          if (counting) {
            reads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
      });
    // Twenty settled turns of ten finished calls, each answer opening with
    // the whitespace text a failed run can leave.
    const history = transcript(
      Array.from({ length: 20 }, (_, turn) => [
        { type: "text" as const, content: "\n\n" },
        ...Array.from({ length: 10 }, (_slot, call) =>
          finishedCall(
            `history-${String(turn)}-${String(call)}`,
            `query ${String(call)}`,
          ),
        ).flat(),
        { type: "text" as const, content: `Answer ${String(turn)}` },
      ]),
    ).map((message) => ({ ...message, parts: message.parts.map(watched) }));
    const finishedCalls = history
      .flatMap(({ parts }) => parts)
      .filter((part) => part.type === "tool-call");
    expect(finishedCalls).toHaveLength(200);

    const ops: AnswerOp[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        kind: "reasoning" as const,
        delta: `step ${String(index)} `,
      })),
      { kind: "status" },
      {
        kind: "tools",
        calls: [{ args: Array.from({ length: 30 }, () => " "), result: false }],
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        kind: "text" as const,
        delta: `word ${String(index)} `,
      })),
    ];
    const readsPerEmit: number[] = [];
    const emits = await streamAnswer({
      history,
      ops,
      onMessages: (messages) => {
        reads = 0;
        counting = true;
        try {
          return show(messages);
        } finally {
          counting = false;
          readsPerEmit.push(reads);
        }
      },
    });
    expect(emits.length).toBeGreaterThan(100);
    // The first emit projects the transcript once: the watched parts reach
    // the projection, so the reads below are not vacuous.
    expect(readsPerEmit.at(0)).toBeGreaterThan(finishedCalls.length);
    expect(Math.max(...readsPerEmit.slice(1))).toBe(0);
  });
});

describe("snapshot and rejoin merges keep what the page shows", () => {
  const message = (id: string, role: "assistant" | "user") =>
    ({ id, parts: [{ type: "text", content: id }], role }) satisfies UIMessage;

  const caseArb = fc
    .tuple(
      fc.array(fc.boolean(), { maxLength: MAX_POSTED, minLength: MIN_ONE }),
      fc.nat({ max: MAX_ADDED }),
    )
    .map(([kept, added]) => {
      const posted = kept.map((_, index) =>
        message(
          `posted-${String(index)}`,
          index % 2 === 0 ? "user" : "assistant",
        ),
      );
      const snapshot = [
        ...posted.filter(
          (_, index) => kept[index] === true || index === posted.length - 1,
        ),
        ...Array.from({ length: added }, (_, index) =>
          message(`added-${String(index)}`, "assistant"),
        ),
      ].map(({ id, parts, role }) => ({ content: "", id, parts, role }));
      return { posted, snapshot };
    });

  test("a snapshot merge hands back the snapshot's own message objects", () => {
    assertProperty(
      "a snapshot merge hands back the snapshot's own message objects",
      fc.property(caseArb, ({ posted, snapshot }) => {
        const reasoned = keepReasoningSteps(snapshot);
        expect(reasoned).toHaveLength(snapshot.length);
        for (const [index, entry] of snapshot.entries()) {
          expect(reasoned.at(index)).toBe(entry);
        }
        const merged = new Set(keepPostedMessages(posted, reasoned));
        for (const entry of snapshot) {
          expect(merged.has(entry)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("a rejoin keeps the shown answer object until replay catches up, then the replayed objects", () => {
    const question = message("question", "user");
    const shownAnswer = {
      id: ANSWER_ID,
      role: "assistant" as const,
      parts: [{ type: "text" as const, content: "Drafting the clause" }],
    } satisfies UIMessage;
    const behind = [
      question,
      { ...shownAnswer, parts: [{ type: "text" as const, content: "Dra" }] },
    ];
    const held = keepShownRejoinMessages([question, shownAnswer], behind);
    expect(held.at(0)).toBe(question);
    expect(held.at(1)).toBe(shownAnswer);

    const caughtUp = [
      question,
      {
        ...shownAnswer,
        parts: [{ type: "text" as const, content: "Drafting the clause now" }],
      },
    ];
    const replayed = keepShownRejoinMessages([question, shownAnswer], caughtUp);
    expect(replayed).toHaveLength(caughtUp.length);
    for (const [index, entry] of caughtUp.entries()) {
      expect(replayed.at(index)).toBe(entry);
    }
  });
});

describe("the chat runtime keeps settled messages while an answer streams", () => {
  const previousFetch = globalThis.fetch;
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  /** Answers the page's chat request with a stream the test writes to. */
  const installStream = () => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
    });
    globalThis.fetch = Object.assign(
      async () => {
        await Promise.resolve();
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      { preconnect: previousFetch.preconnect },
    );
    return {
      close: () => {
        controller?.close();
      },
      push: (...events: Record<string, unknown>[]) => {
        for (const event of events) {
          controller?.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
      },
    };
  };

  /** The client reads the stream a chunk per task: wait until it has read
   *  as far as the test needs. */
  const waitFor = async (reached: () => boolean) => {
    for (let index = 0; index < 2000 && !reached(); index += 1) {
      await sleep(0);
    }
    expect(reached()).toBe(true);
  };

  const answer = (runtime: ChatRuntime) =>
    runtime.getSnapshot().messages.find(({ id }) => id === ANSWER_ID);

  test("every chunk hands subscribers the settled messages and parts they already hold", async () => {
    const server = installStream();
    const history = transcript([
      [
        { type: "text", content: "\n\n" },
        ...finishedCall("settled-call", "terms"),
        { type: "text", content: "Found the terms" },
      ],
    ]);
    const runtime = createChatRuntime({
      activeTurnId: null,
      context: undefined,
      initialMessages: history,
      key: { scope: "global", threadId: toChatThreadId("thread-identity") },
      onError: () => undefined,
      onFinish: () => undefined,
      reloadThread: () => undefined,
      scheduleEmit: () => () => undefined,
    });
    const sent = sendThreadChatMessage(runtime, {
      content: "Find the records",
      id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000001"),
    });
    server.push(
      {
        type: "RUN_STARTED",
        runId: "run-identity",
        threadId: "thread-identity",
      },
      { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
    );
    await waitFor(() => answer(runtime) !== undefined);
    const settled = runtime.getSnapshot().messages.slice(0, history.length);
    // The page drops the settled reply's whitespace part, so the reply it
    // shows is the runtime's own object, not the one it was seeded with.
    expect(history.at(1)?.parts).toHaveLength(4);
    expect(settled.at(1)?.parts).toHaveLength(3);
    const expectSettled = () => {
      const messages = runtime.getSnapshot().messages;
      for (const [index, message] of settled.entries()) {
        const current = messages.at(index);
        expect(current).toBe(message);
        for (const [partIndex, part] of message.parts.entries()) {
          expect(current?.parts.at(partIndex)).toBe(part);
        }
      }
    };
    let text = "";
    for (let index = 0; index < 20; index += 1) {
      const delta = `word ${String(index)} `;
      text += delta;
      const expected = text;
      server.push({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: ANSWER_ID,
        delta,
      });
      await waitFor(
        () =>
          answer(runtime)?.parts.some(
            (part) => part.type === "text" && part.content === expected,
          ) === true,
      );
      expectSettled();
    }
    server.push(
      {
        type: "TOOL_CALL_START",
        toolCallId: "streamed-call",
        toolCallName: TOOL_NAME,
        parentMessageId: ANSWER_ID,
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "streamed-call", delta: '{"q":' },
    );
    await waitFor(
      () =>
        answer(runtime)?.parts.some(
          (part) => part.type === "tool-call" && part.arguments === '{"q":',
        ) === true,
    );
    expectSettled();
    server.push(
      { type: "TOOL_CALL_ARGS", toolCallId: "streamed-call", delta: '"x"}' },
      { type: "TOOL_CALL_END", toolCallId: "streamed-call" },
      { type: "TEXT_MESSAGE_END", messageId: ANSWER_ID },
      {
        type: "RUN_FINISHED",
        runId: "run-identity",
        threadId: "thread-identity",
        finishReason: "stop",
      },
    );
    server.close();
    await sent;
    expectSettled();
  });
});
