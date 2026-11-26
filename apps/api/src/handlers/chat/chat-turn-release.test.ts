import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { HARNESS_QUESTION_TOOL, harnessSessionId } from "@stll/agent-engine";
import { chatLocalRunRequestsOf } from "@stll/api-contract/chat-local-run-request";

import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  adoptedSource,
  createComputer,
  harnessChunks,
  isAsk,
  localSource,
  REQUEST_ID,
} from "@/api/tests/helpers/fake-local-computer";

import type { StreamChatFinishEvent } from "./stream-chat";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createTurnMessageIdMapper } from "./stream-message-identity";
import type { ChatMessage, PersistableChatMessage } from "./types";

// A turn released by a stopping task and adopted by another, read through
// the processor that stores a turn: the released task stores the answer so
// far, the adopter continues it, and the turn ends with the answer one task
// would have stored.

const toolCall = {
  id: "item_7",
  name: "command_execution",
  input: { command: "bun test" },
};

/** A harness turn with text on both sides of a call. */
const turnChunks = async () =>
  await harnessChunks([
    {
      type: "session.started",
      sessionId: harnessSessionId("session-released"),
      continuation: { type: "fresh" },
    },
    { type: "text.delta", messageId: "answer", delta: "Running the tests. " },
    { type: "tool.started", toolCall },
    {
      type: "tool.completed",
      toolCall,
      result: { content: "12 pass", status: "succeeded" },
    },
    { type: "text.delta", messageId: "answer", delta: "All tests pass." },
    {
      type: "text.completed",
      messageId: "answer",
      text: "Running the tests. All tests pass.",
    },
    { type: "turn.completed", usage: null, boundary: null },
  ]);

const question = {
  id: "item_9",
  name: HARNESS_QUESTION_TOOL,
  input: { questions: ["Which law governs the lease?"] },
};

/**
 * A harness turn that asks the member a question, takes the answer and
 * drafts on.
 */
const questionTurnChunks = async () =>
  await harnessChunks([
    {
      type: "session.started",
      sessionId: harnessSessionId("session-asked"),
      continuation: { type: "fresh" },
    },
    { type: "text.delta", messageId: "answer", delta: "Before drafting: " },
    {
      type: "question.requested",
      request: {
        requestId: REQUEST_ID,
        toolCall: question,
        questions: [
          {
            id: "law",
            header: "Governing law",
            prompt: "Which law governs the lease?",
            options: [
              { label: "Czech", description: "Czech Civil Code" },
              { label: "Slovak", description: "Slovak Civil Code" },
            ],
            allowsFreeText: false,
            multiSelect: false,
            secret: false,
          },
        ],
        answerWith: "response",
      },
    },
    { type: "interaction.resolved", requestId: REQUEST_ID },
    {
      type: "tool.completed",
      toolCall: question,
      result: { content: "Czech", status: "succeeded" },
    },
    { type: "text.delta", messageId: "answer", delta: "Czech law governs." },
    {
      type: "text.completed",
      messageId: "answer",
      text: "Before drafting: Czech law governs.",
    },
    { type: "turn.completed", usage: null, boundary: null },
  ]);

type Processed = {
  /** What the turn's log and viewers receive. */
  emitted: PublicStreamChunk[];
  finished: StreamChatFinishEvent | undefined;
  released: PersistableChatMessage | undefined;
};

/** Read `source` through the processor that stores a turn. */
const processTurn = async ({
  initialMessages,
  source,
}: {
  /** The released answer an adopted read continues; none for a new turn. */
  initialMessages: ChatMessage[];
  source: AsyncIterable<PublicStreamChunk>;
}): Promise<Processed> => {
  const { processor, message } = createStreamMessageCapture({
    initialMessages,
    capture: toChatMessage,
  });
  const processed: Processed = {
    emitted: [],
    finished: undefined,
    released: undefined,
  };
  const never = new AbortController().signal;
  for await (const chunk of processServerChatStream({
    abortSignal: never,
    deadlineSignal: never,
    getResponseMessage: message,
    initialMessages,
    // An adopted read continues the released answer under its id.
    mapMessageId: createTurnMessageIdMapper(
      initialMessages.length === 0
        ? undefined
        : toSafeId<"chatMessage">(initialMessages[0]?.id ?? ""),
    ),
    processor,
    source,
    answerSoFar: initialMessages.length === 0 ? "none" : "released",
    onFinish: (event) => {
      processed.finished = event;
    },
    onRelease: (answer) => {
      processed.released = answer;
    },
  })) {
    processed.emitted.push(chunk);
  }
  return processed;
};

/** The answer a page builds from what a turn's viewers received. */
const pageAnswer = (emitted: readonly PublicStreamChunk[]) => {
  const { processor, message } = createStreamMessageCapture({
    initialMessages: [],
    capture: (answer) => answer,
  });
  for (const chunk of emitted) {
    processor.processChunk(chunk);
  }
  processor.finalizeStream();
  return message() ?? panic("The page built no answer");
};

/** The answer one uninterrupted read stores, and what its page shows. */
const uninterruptedAnswer = async (chunks: readonly StreamChunk[]) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  const { emitted, finished } = await processTurn({
    initialMessages: [],
    source: localSource(computer)(new AbortController().signal),
  });
  return {
    page: pageAnswer(emitted),
    stored: finished ?? panic("The uninterrupted turn did not finish"),
  };
};

/**
 * The answer a task stores when it is asked to release the turn once its
 * read caught up with the first `cut` events, while the computer goes on
 * with the rest: the read stops at the first boundary it may stop at.
 */
const readAskedToRelease = async (
  chunks: readonly StreamChunk[],
  cut: number,
) => {
  const computer = createComputer();
  computer.events(chunks.slice(0, cut));
  const handOver = new AbortController();
  const { control } = computer.context;
  computer.context.control = {
    ...control,
    // A read asks for the run's state only once no stored event is left.
    readRun: async (options) => {
      if (!handOver.signal.aborted) {
        handOver.abort();
        computer.events(chunks.slice(cut));
      }
      return await control.readRun(options);
    },
  };
  const processed = await processTurn({
    initialMessages: [],
    source: localSource(computer)(
      new AbortController().signal,
      handOver.signal,
    ),
  });
  return { ...processed, readSeq: computer.chatReadSeq() };
};

/** The answer a task released at `cut` stores (see `readAskedToRelease`). */
const releasedAnswer = async (chunks: readonly StreamChunk[], cut: number) => {
  const { emitted, finished, released, readSeq } = await readAskedToRelease(
    chunks,
    cut,
  );
  expect(finished).toBeUndefined();
  return {
    answer: released ?? panic("The turn was not released"),
    emitted,
    readSeq,
  };
};

/** The answer the adopter stores, continuing `released` from `readSeq`. */
const adoptedAnswer = async ({
  chunks,
  readSeq,
  released,
}: {
  chunks: readonly StreamChunk[];
  readSeq: number;
  released: PersistableChatMessage;
}) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  computer.releaseAt(readSeq);
  const checkpoint = released;
  const { emitted, finished } = await processTurn({
    initialMessages: [checkpoint],
    source: adoptedSource(computer)(new AbortController().signal),
  });
  return {
    emitted,
    stored: finished ?? panic("The adopted turn did not finish"),
  };
};

describe("a local turn released mid-answer and adopted", () => {
  test("stores the answer one task would have stored, from every cut", async () => {
    const chunks = await turnChunks();
    const whole = await uninterruptedAnswer(chunks);
    expect(whole.stored.outcome).toEqual({ type: "completed" });
    // Every event boundary a released reader can stop at, before the
    // harness's finish (after it, the read runs on to the run's end).
    const finish = chunks.findIndex(
      (chunk) => chunk.type === EventType.RUN_FINISHED,
    );
    expect(finish).toBeGreaterThan(0);
    for (let cut = 0; cut < finish; cut += 1) {
      const released = await releasedAnswer(chunks, cut);
      expect(released.answer.metadata?.turnOutcome).toBeUndefined();
      const adopted = await adoptedAnswer({
        chunks,
        readSeq: released.readSeq,
        released: released.answer,
      });

      expect({ cut, outcome: adopted.stored.outcome }).toEqual({
        cut,
        outcome: whole.stored.outcome,
      });
      expect({ cut, parts: adopted.stored.responseMessage.parts }).toEqual({
        cut,
        parts: whole.stored.responseMessage.parts,
      });
      // A page that read the released task's chunks, then the adopter's,
      // shows the same answer as a page that read one task's.
      const page = pageAnswer([...released.emitted, ...adopted.emitted]);
      expect({ cut, parts: page.parts }).toEqual({
        cut,
        parts: whole.page.parts,
      });
    }
  });
});

describe("a local turn asked to release while the harness asks a question", () => {
  test("hands the waiting question to the adopter from every cut, and stores the answer one task would have stored", async () => {
    const chunks = await questionTurnChunks();
    const whole = await uninterruptedAnswer(chunks);
    // The turn never pauses on the question: it runs on and completes,
    // and the page reads the question as answered beside it.
    expect(whole.stored.outcome).toEqual({ type: "completed" });
    expect(chatLocalRunRequestsOf(whole.page.metadata)).toMatchObject([
      { requestId: REQUEST_ID, status: "resolved", ask: { kind: "question" } },
    ]);
    const interrupt = chunks.findIndex(isAsk);
    expect(interrupt).toBeGreaterThan(0);
    const finish = chunks.findIndex(
      (chunk) => chunk.type === EventType.RUN_FINISHED && !isAsk(chunk),
    );
    expect(finish).toBeGreaterThan(interrupt);
    // The question's whole input is read just before its interrupt: a read
    // asked to release there waits for the interrupt, which hands the
    // question to its request, then releases.
    expect(chunks[interrupt - 1]?.type).toBe(EventType.TOOL_CALL_END);
    const waited = await releasedAnswer(chunks, interrupt);
    expect(waited.readSeq).toBe(interrupt + 1);
    expect(
      chatLocalRunRequestsOf(pageAnswer(waited.emitted).metadata).map(
        ({ status }) => status,
      ),
    ).toEqual(["pending"]);
    for (let cut = 0; cut < finish; cut += 1) {
      const released = await releasedAnswer(chunks, cut);
      const adopted = await adoptedAnswer({
        chunks,
        readSeq: released.readSeq,
        released: released.answer,
      });
      expect({ cut, outcome: adopted.stored.outcome }).toEqual({
        cut,
        outcome: whole.stored.outcome,
      });
      expect({ cut, parts: adopted.stored.responseMessage.parts }).toEqual({
        cut,
        parts: whole.stored.responseMessage.parts,
      });
      // A page that read the released task's chunks, then the adopter's,
      // shows the same answer and the same request as one task's.
      const page = pageAnswer([...released.emitted, ...adopted.emitted]);
      expect({ cut, parts: page.parts }).toEqual({
        cut,
        parts: whole.page.parts,
      });
      expect({ cut, requests: chatLocalRunRequestsOf(page.metadata) }).toEqual({
        cut,
        requests: chatLocalRunRequestsOf(whole.page.metadata),
      });
    }
  });
});
