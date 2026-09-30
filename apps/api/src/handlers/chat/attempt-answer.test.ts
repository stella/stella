import { chat, EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { chunkCarriesAnswer } from "@/api/handlers/chat/attempt-answer";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  createScriptedTextAdapter,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";

const ANSWERED_QUESTION = {
  arguments: "{}",
  id: "call-asked",
  name: ASK_USER_TOOL_NAME,
  output: { answers: [{ answer: "Buyer", question: "Which side?" }] },
  state: "input-complete",
  type: "tool-call",
} as const;

/** The message a continuation resumes, once the user answered the question
 *  it asked. */
const CONTINUED_HISTORY: UIMessage[] = [
  {
    id: "user-1",
    parts: [{ content: "Draft the NDA", type: "text" }],
    role: "user",
  },
  {
    id: "provider-message-1",
    parts: [
      { content: "One question first.", type: "text" },
      ANSWERED_QUESTION,
    ],
    role: "assistant",
  },
];

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
  [
    "text the continued message already held",
    { finishReason: "stop", text: "One question first.", type: "text" },
    true,
  ],
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

const streamed = async (turn: ScriptedTurn): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of scriptedTurnChunks(turn, {
    index: 0,
    model: "scripted",
    runId: "run-1",
    threadId: "thread-1",
  })) {
    chunks.push(chunk);
  }
  return chunks;
};

describe("whether a run answered", () => {
  test.each(RUNS)("a run that streams %s", async (_run, turn, answers) => {
    const chunks = await streamed(turn);

    expect(chunks.some(chunkCarriesAnswer)).toBe(answers);
  });
});

// The attempt middleware watches every chunk the engine pipes through it. A
// continuation resumes with the call the user answered, and the engine keeps
// that call to itself: the middleware hears only what the model streams, so
// the chunk reading and the message reading agree about a run that then says
// nothing.
describe("what the engine pipes through the attempt middleware", () => {
  const askUserTool = toolDefinition({
    name: ASK_USER_TOOL_NAME,
    description: "Client-rendered clarification",
    inputSchema: toTanStackToolSchema(v.object({})),
  });

  const seenByMiddleware = async (turn: ScriptedTurn) => {
    const chunks: StreamChunk[] = [];
    const run = chat({
      adapter: createScriptedTextAdapter([turn]),
      agentLoopStrategy: maxIterations(3),
      messages: CONTINUED_HISTORY,
      middleware: [
        {
          name: "attempt-answer-test",
          onChunk: (_ctx, chunk) => {
            chunks.push(chunk);
          },
        },
      ],
      parentRunId: "run-0",
      resume: [
        {
          interruptId: `client_tool_${ANSWERED_QUESTION.id}`,
          payload: ANSWERED_QUESTION.output,
          status: "resolved",
        },
      ],
      runId: "run-1",
      threadId: "thread-1",
      tools: [askUserTool],
    });
    for await (const _chunk of run) {
      // Drained for the middleware's sake.
    }
    return chunks;
  };

  const namesAnsweredCall = (chunk: StreamChunk): boolean =>
    (chunk.type === EventType.TOOL_CALL_START ||
      chunk.type === EventType.TOOL_CALL_ARGS ||
      chunk.type === EventType.TOOL_CALL_END ||
      chunk.type === EventType.TOOL_CALL_RESULT) &&
    chunk.toolCallId === ANSWERED_QUESTION.id;

  test("a continuation that says nothing streams no answer", async () => {
    const chunks = await seenByMiddleware({
      finishReason: "stop",
      text: "",
      type: "text",
    });

    expect(chunks.map(({ type }) => type)).toContain(EventType.RUN_FINISHED);
    expect(chunks.filter(namesAnsweredCall)).toEqual([]);
    expect(chunks.some(chunkCarriesAnswer)).toBe(false);
  });

  test("a continuation that answers streams an answer", async () => {
    const chunks = await seenByMiddleware({
      finishReason: "stop",
      text: "Here it is.",
      type: "text",
    });

    expect(chunks.some(chunkCarriesAnswer)).toBe(true);
  });
});
