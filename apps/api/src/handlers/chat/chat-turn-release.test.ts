import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { harnessSessionId } from "@stll/agent-engine";

import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  adoptedSource,
  createComputer,
  harnessChunks,
  localSource,
} from "@/api/tests/helpers/fake-local-computer";

import { toPersistableChatMessage } from "./chat-message-parts";
import type { StreamChatFinishEvent } from "./stream-chat";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createTurnMessageIdMapper } from "./stream-message-identity";
import type { ChatMessage } from "./types";

// A turn released by a stopping task and adopted by another, read through
// the processor that stores a turn: the released task stores the answer so
// far, the adopter continues it, and the turn ends with the answer one task
// would have stored.

const ANSWER_ID = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222222",
);

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

type Processed = {
  finished: StreamChatFinishEvent | undefined;
  released: ChatMessage | undefined;
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
  const processed: Processed = { finished: undefined, released: undefined };
  const never = new AbortController().signal;
  for await (const _chunk of processServerChatStream({
    abortSignal: never,
    deadlineSignal: never,
    getResponseMessage: message,
    initialMessages,
    mapMessageId: createTurnMessageIdMapper(
      initialMessages.length === 0 ? undefined : ANSWER_ID,
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
    // Drained for its side effects: the stored answer.
  }
  return processed;
};

/** The answer one uninterrupted read stores. */
const uninterruptedAnswer = async (chunks: readonly StreamChunk[]) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  const { finished } = await processTurn({
    initialMessages: [],
    source: localSource(computer)(new AbortController().signal),
  });
  return finished ?? panic("The uninterrupted turn did not finish");
};

/**
 * The answer a task stores when it is asked to release the turn once its
 * read caught up with the first `cut` events, while the computer goes on
 * with the rest: the read stops at the first boundary it may stop at.
 */
const releasedAnswer = async (chunks: readonly StreamChunk[], cut: number) => {
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
  const { finished, released } = await processTurn({
    initialMessages: [],
    source: localSource(computer)(
      new AbortController().signal,
      handOver.signal,
    ),
  });
  expect(finished).toBeUndefined();
  return {
    answer: released ?? panic("The turn was not released"),
    readSeq: computer.chatReadSeq(),
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
  released: ChatMessage;
}) => {
  const computer = createComputer();
  computer.events(chunks);
  computer.finish();
  computer.releaseAt(readSeq);
  const checkpoint = toPersistableChatMessage({ ...released, id: ANSWER_ID });
  const { finished } = await processTurn({
    initialMessages: [checkpoint],
    source: adoptedSource(computer)(new AbortController().signal),
  });
  return finished ?? panic("The adopted turn did not finish");
};

describe("a local turn released mid-answer and adopted", () => {
  test("stores the answer one task would have stored, from every cut", async () => {
    const chunks = await turnChunks();
    const whole = await uninterruptedAnswer(chunks);
    expect(whole.outcome).toEqual({ type: "completed" });
    // Every event boundary a released reader can stop at, before the
    // harness's finish (after it, the read runs on to the run's end).
    const finish = chunks.findIndex(
      (chunk) => chunk.type === EventType.RUN_FINISHED,
    );
    expect(finish).toBeGreaterThan(0);
    for (let cut = 0; cut < finish; cut += 1) {
      const { answer, readSeq } = await releasedAnswer(chunks, cut);
      expect(answer.metadata?.turnOutcome).toBeUndefined();
      const adopted = await adoptedAnswer({
        chunks,
        readSeq,
        released: answer,
      });

      expect({ cut, outcome: adopted.outcome }).toEqual({
        cut,
        outcome: whole.outcome,
      });
      expect({ cut, parts: adopted.responseMessage.parts }).toEqual({
        cut,
        parts: whole.responseMessage.parts,
      });
    }
  });
});
