import { describe, expect, test } from "bun:test";

import { resolveChatTurnModel } from "@/api/handlers/chat/turn-model";
import type { ChatMessage } from "@/api/handlers/chat/types";

const originalModel = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  reasoningEffort: "medium",
} as const;

const toolTurn = (approved: boolean): ChatMessage => ({
  id: "assistant-turn",
  role: "assistant",
  metadata: { turnModel: originalModel },
  parts: [
    {
      type: "thinking",
      content: "Retained turn reasoning",
      signature: "original-signature",
    },
    {
      type: "tool-call",
      id: "tool-1",
      name: "mcp__test_tool",
      arguments: "{}",
      state: "approval-responded",
      approval: { id: "approval-1", needsApproval: true, approved },
    },
  ],
});

describe("assistant turn model ownership", () => {
  for (const approved of [true, false]) {
    for (const requestedModelId of [
      "openai::gpt-6",
      "google::gemini-2.5-pro",
      "anthropic::claude-opus-4-6",
      undefined,
    ]) {
      test(`keeps original Anthropic model after ${approved ? "approval" : "decline"} when requesting ${requestedModelId ?? "Auto"}`, () => {
        const message = toolTurn(approved);
        const before = structuredClone(message);
        expect(
          resolveChatTurnModel({
            messages: [message],
            owningAssistantMessageId: message.id,
            requestedModelId,
            requestedReasoningEffort: "high",
            canServe: () => true,
          }),
        ).toEqual({
          modelId: "anthropic::claude-sonnet-4-6",
          reasoningEffort: "medium",
        });
        expect(message).toEqual(before);
      });
    }
  }

  test("applies the requested switch at the next user turn", () => {
    expect(
      resolveChatTurnModel({
        messages: [
          toolTurn(false),
          {
            id: "next-user",
            role: "user",
            parts: [{ type: "text", content: "Next question" }],
          },
        ],
        owningAssistantMessageId: undefined,
        requestedModelId: "openai::gpt-6",
        requestedReasoningEffort: "high",
        canServe: () => true,
      }),
    ).toEqual({ modelId: "openai::gpt-6", reasoningEffort: "high" });
  });

  test("continues a turn stored without its model on the requested model", () => {
    const message = toolTurn(false);
    delete message.metadata;
    expect(
      resolveChatTurnModel({
        messages: [message],
        owningAssistantMessageId: message.id,
        requestedModelId: "openai::gpt-6",
        requestedReasoningEffort: undefined,
        canServe: () => true,
      }),
    ).toEqual({ modelId: "openai::gpt-6", reasoningEffort: undefined });
  });

  test("continues on the requested model once the organization can no longer serve the original", () => {
    const served: string[] = [];
    expect(
      resolveChatTurnModel({
        messages: [toolTurn(true)],
        owningAssistantMessageId: "assistant-turn",
        requestedModelId: "openai::gpt-6",
        requestedReasoningEffort: "high",
        canServe: (modelId) => {
          served.push(modelId);
          return false;
        },
      }),
    ).toEqual({ modelId: "openai::gpt-6", reasoningEffort: "high" });
    expect(served).toEqual(["anthropic::claude-sonnet-4-6"]);
  });
});
