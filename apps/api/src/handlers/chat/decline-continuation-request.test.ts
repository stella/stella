import { chat, EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type {
  AdapterYieldChunk,
  AnyTextAdapter,
  ModelMessage,
} from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { guardProviderHistory } from "@/api/handlers/chat/provider-history";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { withReasoningBoundToProvider } from "@/api/lib/chat/provider-bound-reasoning";
import { findTranscriptProblems } from "@/api/tests/helpers/provider-request-transcript";

const captureAdapter = (sink: ModelMessage[][]): AnyTextAdapter => ({
  kind: "text",
  name: "capture",
  model: "capture",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ messages, model, runId, threadId }) {
    sink.push(structuredClone(messages));
    const timestamp = Date.now();
    yield {
      type: EventType.RUN_STARTED,
      runId: runId ?? "run-2",
      threadId: threadId ?? "thread-1",
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: runId ?? "run-2",
      threadId: threadId ?? "thread-1",
      finishReason: "stop",
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
  },
  structuredOutput: () =>
    panic("Structured output is not part of this fixture"),
});

const thinking = (id: string): ChatPart => ({
  type: "thinking",
  content: `think ${id}`,
  signature: JSON.stringify({ id, encrypted_content: `enc ${id}` }),
});

const declinedCall: ChatPart = {
  metadata: { itemId: "fc_1" },
  approval: { approved: false, id: "approval_call-1", needsApproval: true },
  arguments: '{"name":"X"}',
  id: "call-1",
  input: { name: "X" },
  name: "save_contact",
  state: "approval-responded",
  type: "tool-call",
};

const SHAPES: Record<string, ChatPart[]> = {
  call: [declinedCall],
  "thinking call": [thinking("rs_1"), declinedCall],
  "thinking text call": [
    thinking("rs_1"),
    { type: "text", content: "Saving." },
    declinedCall,
  ],
  "thinking call text": [
    thinking("rs_1"),
    declinedCall,
    { type: "text", content: "Waiting." },
  ],
  "thinking text thinking call": [
    thinking("rs_1"),
    { type: "text", content: "Saving." },
    thinking("rs_2"),
    declinedCall,
  ],
};

// A declined approval resumes the run: the request that continues it must
// answer the declined call exactly once, with its own call id, before any
// later item, for every shape the stored message can take.
describe("the request continuing a declined approval", () => {
  for (const [name, parts] of Object.entries(SHAPES)) {
    test(`answers the declined call once: ${name}`, async () => {
      const saveContact = toolDefinition({
        name: "save_contact",
        description: "Saves a contact after approval",
        inputSchema: toTanStackToolSchema(v.object({ name: v.string() })),
        needsApproval: true,
      }).server(async () => ({ id: "c1" }));
      const history: ChatMessage[] = [
        { id: "u1", role: "user", parts: [{ type: "text", content: "Save" }] },
        { id: "a1", role: "assistant", parts },
      ];
      const messages = guardProviderHistory({
        messages: history,
        workspaceIds: [],
      });
      const sink: ModelMessage[][] = [];
      for await (const _chunk of chat({
        adapter: captureAdapter(sink),
        agentLoopStrategy: maxIterations(3),
        messages,
        parentRunId: "run-1",
        resume: [
          {
            interruptId: "approval_call-1",
            payload: { approved: false },
            status: "resolved",
          },
        ],
        runId: "run-2",
        threadId: "thread-1",
        tools: [saveContact],
      })) {
        // drain
      }
      const adapter = createOpenaiChat("gpt-5.2", "test-key");
      const convert: unknown = Reflect.get(adapter, "convertMessagesToInput");
      if (typeof convert !== "function") {
        return panic("The OpenAI adapter no longer converts messages to input");
      }
      const input: unknown = Reflect.apply(convert, adapter, [
        withReasoningBoundToProvider(sink[0] ?? [], "openai"),
      ]);
      const problems = findTranscriptProblems({
        format: "openai-responses",
        body: { input },
      });
      expect(sink).toHaveLength(1);
      expect(problems).toEqual([]);
      if (!Array.isArray(input)) {
        return panic("The OpenAI adapter returned a non-array input");
      }
      const items: unknown[] = input;
      const typeOf = (item: unknown): unknown =>
        typeof item === "object" && item !== null
          ? Reflect.get(item, "type")
          : undefined;
      const callIdOf = (item: unknown): unknown =>
        typeof item === "object" && item !== null
          ? Reflect.get(item, "call_id")
          : undefined;
      const callAt = items.findIndex(
        (item) => typeOf(item) === "function_call",
      );
      const outputs = items.flatMap((item, index) =>
        typeOf(item) === "function_call_output" ? [index] : [],
      );
      expect(outputs).toHaveLength(1);
      const [outputAt] = outputs;
      expect(callAt).toBeGreaterThan(-1);
      expect(outputAt).toBeGreaterThan(callAt);
      expect(callIdOf(items[outputAt ?? -1])).toBe("call-1");
      expect(callIdOf(items[callAt])).toBe("call-1");
    });
  }
});
