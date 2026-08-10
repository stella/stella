import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_PROMPT_IMPROVEMENT_STRATEGIES } from "@stll/api-contract/chat";

import improvePrompt from "@/api/handlers/chat/improve-prompt";

describe("prompt improvement request", () => {
  test("accepts every shared strategy", () => {
    for (const strategy of CHAT_PROMPT_IMPROVEMENT_STRATEGIES) {
      expect(
        Value.Check(improvePrompt.config.body, {
          prompt: "Review this agreement",
          sendMode: CHAT_SEND_MODE.rawOverride,
          strategy,
        }),
      ).toBe(true);
    }
  });

  test("rejects missing and unknown strategies", () => {
    const request = {
      prompt: "Review this agreement",
      sendMode: CHAT_SEND_MODE.rawOverride,
    };

    expect(Value.Check(improvePrompt.config.body, request)).toBe(false);
    expect(
      Value.Check(improvePrompt.config.body, {
        ...request,
        strategy: "make-formal",
      }),
    ).toBe(false);
  });
});
