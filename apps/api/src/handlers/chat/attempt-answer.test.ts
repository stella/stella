import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  attemptProducedAnswer,
  chunkCarriesAnswer,
} from "@/api/handlers/chat/attempt-answer";
import { toChatMessage } from "@/api/handlers/chat/stream-chat";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { scriptedTurnChunks } from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";

/** The id the scripted provider gives the message of a run's first step. */
const ASSISTANT_MESSAGE_ID = "provider-message-1";

const USER_MESSAGE: UIMessage = {
  id: "user-1",
  parts: [{ content: "Draft the NDA", type: "text" }],
  role: "user",
};

const ANSWERED_QUESTION = {
  arguments: "{}",
  id: "call-asked",
  name: ASK_USER_TOOL_NAME,
  output: { answers: [{ answer: "Buyer", question: "Which side?" }] },
  state: "input-complete",
  type: "tool-call",
} as const;

/** What the run starts from: nothing of its own, or the message it continues
 *  once the user answered the question that message asked. */
const HISTORIES: Record<string, UIMessage[]> = {
  "a fresh turn": [USER_MESSAGE],
  "a continuation": [
    USER_MESSAGE,
    {
      id: ASSISTANT_MESSAGE_ID,
      parts: [
        { content: "One question first.", type: "text" },
        ANSWERED_QUESTION,
      ],
      role: "assistant",
    },
  ],
  "a continuation of a message that ends in text": [
    USER_MESSAGE,
    {
      id: ASSISTANT_MESSAGE_ID,
      parts: [
        ANSWERED_QUESTION,
        { content: "One question first.", type: "text" },
      ],
      role: "assistant",
    },
  ],
};

const NEW_CALL = {
  arguments: "{}",
  toolCallId: "call-new",
  toolName: "list_templates",
};

/** What the model's run streams, and whether that is an answer. */
const RUNS: [string, ScriptedTurn, boolean][] = [
  ["nothing", { toolCalls: [], type: "step" }, false],
  ["an empty text", { finishReason: "stop", text: "", type: "text" }, false],
  ["whitespace", { finishReason: "stop", text: " \n\t", type: "text" }, false],
  ["thinking only", { reasoning: "Hm.", toolCalls: [], type: "step" }, false],
  [
    "thinking and whitespace",
    { reasoning: "Hm.", text: "\n", toolCalls: [], type: "step" },
    false,
  ],
  ["text", { finishReason: "stop", text: "Here it is.", type: "text" }, true],
  ["a tool call", { toolCalls: [NEW_CALL], type: "step" }, true],
  [
    "whitespace and a tool call",
    { text: " ", toolCalls: [NEW_CALL], type: "step" },
    true,
  ],
  [
    "thinking and text",
    { reasoning: "Hm.", text: "Here it is.", toolCalls: [], type: "step" },
    true,
  ],
];

const CASES = Object.entries(HISTORIES).flatMap(([history, messages]) =>
  RUNS.map(
    ([run, turn, answers]) => [history, run, messages, turn, answers] as const,
  ),
);

/** Runs `turn` through the SDK's own stream processor, as a turn's
 *  persistence does, and returns its chunks and the parts it left. */
const streamed = async (initialMessages: UIMessage[], turn: ScriptedTurn) => {
  const { message, processor } = createStreamMessageCapture({
    capture: toChatMessage,
    initialMessages,
  });
  const chunks: StreamChunk[] = [];
  const source = scriptedTurnChunks(turn, {
    index: 0,
    model: "scripted",
    runId: "run-1",
    threadId: "thread-1",
  });
  for await (const chunk of source) {
    chunks.push(chunk);
    processor.processChunk(chunk);
  }
  processor.finalizeStream();
  const continued = initialMessages.find(
    ({ id }) => id === ASSISTANT_MESSAGE_ID,
  );
  return {
    after: message()?.parts ?? [],
    before:
      continued === undefined ? [] : (toChatMessage(continued)?.parts ?? []),
    chunks,
  };
};

describe("whether a run answered", () => {
  test.each(CASES)(
    "%s that streams %s",
    async (_history, _run, messages, turn, answers) => {
      const { after, before, chunks } = await streamed(messages, turn);

      // Both readings, the chunks the attempt watches and the message the
      // terminal guard reads, say the same thing about the same run.
      expect(chunks.some(chunkCarriesAnswer)).toBe(answers);
      expect(attemptProducedAnswer({ after, before })).toBe(answers);
    },
  );

  test("the continued message alone is never the run's answer", async () => {
    const messages = HISTORIES["a continuation"] ?? [];
    const { before } = await streamed(messages, {
      toolCalls: [],
      type: "step",
    });

    // The fixture must reach the fault: the message holds a call and text.
    expect(before.map(({ type }) => type)).toEqual(["text", "tool-call"]);
    expect(attemptProducedAnswer({ after: before, before })).toBe(false);
    expect(attemptProducedAnswer({ after: before, before: [] })).toBe(true);
  });
});
