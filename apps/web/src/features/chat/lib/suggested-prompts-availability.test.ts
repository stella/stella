import { describe, expect, test } from "bun:test";

import {
  resolveSuggestedPromptsAvailability,
  resolveSuggestedPromptsTurnOwner,
} from "@/features/chat/lib/suggested-prompts-availability";

const ELIGIBLE_INPUT = {
  editorIsEmpty: true,
  error: undefined,
  isGenerating: false,
  lastMessage: {
    id: "assistant-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, content: "Done" }],
  },
  turnAbandoned: false,
  turnOwner: "composer" as const,
};

describe("resolveSuggestedPromptsAvailability", () => {
  test("allows suggestions after a successful assistant turn", () => {
    expect(resolveSuggestedPromptsAvailability(ELIGIBLE_INPUT)).toEqual({
      status: "eligible",
      lastMessageId: "assistant-1",
    });
  });

  test("blocks suggestions after a failed assistant turn", () => {
    expect(
      resolveSuggestedPromptsAvailability({
        ...ELIGIBLE_INPUT,
        error: new Error("stream failed"),
      }),
    ).toEqual({ status: "blocked", reason: "error" });
  });

  test("uses the persisted terminal outcome after reload", () => {
    expect(
      resolveSuggestedPromptsAvailability({
        ...ELIGIBLE_INPUT,
        lastMessage: {
          ...ELIGIBLE_INPUT.lastMessage,
          metadata: {
            turnOutcome: {
              type: "failed",
              error: "provider_unavailable",
            },
          },
        },
      }),
    ).toEqual({ status: "blocked", reason: "terminal-outcome" });

    for (const reason of ["client-disconnected", "timeout"] as const) {
      expect(
        resolveSuggestedPromptsAvailability({
          ...ELIGIBLE_INPUT,
          lastMessage: {
            ...ELIGIBLE_INPUT.lastMessage,
            metadata: { turnOutcome: { type: "interrupted", reason } },
          },
        }),
      ).toEqual({ status: "blocked", reason: "terminal-outcome" });
    }
  });

  test("keeps persisted cancellations quiet and ineligible", () => {
    for (const reason of ["superseded", "user-stop"] as const) {
      expect(
        resolveSuggestedPromptsAvailability({
          ...ELIGIBLE_INPUT,
          lastMessage: {
            ...ELIGIBLE_INPUT.lastMessage,
            metadata: { turnOutcome: { type: "cancelled", reason } },
          },
        }),
      ).toEqual({ status: "blocked", reason: "terminal-outcome" });
    }
  });

  test("keeps persisted human interactions user-owned", () => {
    for (const interaction of [
      { type: "ask-user", toolCallId: "ask-1" },
      { type: "approval", toolCallId: "approval-1" },
    ] as const) {
      expect(
        resolveSuggestedPromptsAvailability({
          ...ELIGIBLE_INPUT,
          lastMessage: {
            ...ELIGIBLE_INPUT.lastMessage,
            metadata: {
              turnOutcome: { type: "awaiting-user", interaction },
            },
          },
        }),
      ).toEqual({ status: "blocked", reason: "terminal-outcome" });
    }
  });

  test("accepts explicit completion and only non-empty legacy turns", () => {
    expect(
      resolveSuggestedPromptsAvailability({
        ...ELIGIBLE_INPUT,
        lastMessage: {
          ...ELIGIBLE_INPUT.lastMessage,
          metadata: { turnOutcome: { type: "completed" } },
          parts: [],
        },
      }),
    ).toEqual({ status: "eligible", lastMessageId: "assistant-1" });
    expect(
      resolveSuggestedPromptsAvailability({
        ...ELIGIBLE_INPUT,
        lastMessage: { ...ELIGIBLE_INPUT.lastMessage, parts: [] },
      }),
    ).toEqual({ status: "blocked", reason: "terminal-outcome" });
  });

  test.each([
    [{ ...ELIGIBLE_INPUT, isGenerating: true }, "generating"],
    [{ ...ELIGIBLE_INPUT, turnAbandoned: true }, "terminal-outcome"],
    [{ ...ELIGIBLE_INPUT, editorIsEmpty: false }, "draft"],
    [{ ...ELIGIBLE_INPUT, lastMessage: null }, "no-assistant-turn"],
    [
      {
        ...ELIGIBLE_INPUT,
        lastMessage: {
          id: "user-1",
          role: "user" as const,
          parts: [{ type: "text" as const, content: "Next" }],
        },
      },
      "no-assistant-turn",
    ],
    [{ ...ELIGIBLE_INPUT, turnOwner: "ask-user" as const }, "turn-owned"],
    [{ ...ELIGIBLE_INPUT, turnOwner: "approval" as const }, "turn-owned"],
  ] as const)("blocks an ineligible chat state", (input, reason) => {
    expect(resolveSuggestedPromptsAvailability(input)).toEqual({
      status: "blocked",
      reason,
    });
  });
});

describe("resolveSuggestedPromptsTurnOwner", () => {
  const assistantMessage = {
    id: "assistant-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, content: "Done" }],
  };

  test("gives pending approvals precedence over the composer", () => {
    expect(
      resolveSuggestedPromptsTurnOwner({
        approvalPendingMessageId: "assistant-1",
        hasReopenedAskUser: false,
        lastMessage: assistantMessage,
      }),
    ).toBe("approval");
  });

  test("keeps pending and reopened clarifications user-owned", () => {
    const pendingAskUser = {
      ...assistantMessage,
      parts: [
        {
          type: "tool-call" as const,
          id: "ask-1",
          name: "ask-user" as const,
          arguments: "{}",
          state: "input-complete" as const,
        },
      ],
    };
    expect(
      resolveSuggestedPromptsTurnOwner({
        approvalPendingMessageId: null,
        hasReopenedAskUser: false,
        lastMessage: pendingAskUser,
      }),
    ).toBe("ask-user");
    expect(
      resolveSuggestedPromptsTurnOwner({
        approvalPendingMessageId: null,
        hasReopenedAskUser: true,
        lastMessage: assistantMessage,
      }),
    ).toBe("ask-user");
  });
});
