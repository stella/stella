import { describe, expect, test } from "bun:test";

import { resolveSuggestedPromptsAvailability } from "@/features/chat/lib/suggested-prompts-availability";

const ELIGIBLE_INPUT = {
  editorIsEmpty: true,
  error: undefined,
  isGenerating: false,
  lastMessage: { id: "assistant-1", role: "assistant" as const },
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

  test.each([
    [{ ...ELIGIBLE_INPUT, isGenerating: true }, "generating"],
    [{ ...ELIGIBLE_INPUT, editorIsEmpty: false }, "draft"],
    [{ ...ELIGIBLE_INPUT, lastMessage: null }, "no-assistant-turn"],
    [
      {
        ...ELIGIBLE_INPUT,
        lastMessage: { id: "user-1", role: "user" as const },
      },
      "no-assistant-turn",
    ],
    [{ ...ELIGIBLE_INPUT, turnOwner: "ask-user" as const }, "turn-owned"],
  ] as const)("blocks an ineligible chat state", (input, reason) => {
    expect(resolveSuggestedPromptsAvailability(input)).toEqual({
      status: "blocked",
      reason,
    });
  });
});
