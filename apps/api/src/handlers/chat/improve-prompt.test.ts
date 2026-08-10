import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_PROMPT_IMPROVEMENT_STRATEGIES } from "@stll/api-contract/chat";

import improvePrompt from "@/api/handlers/chat/improve-prompt";
import { buildPromptImprovementModelInput } from "@/api/handlers/chat/improve-prompt-instructions";

const LEGAL_CONTEXT_PREFIX =
  "The prompt is for work in a legal context. Preserve the user's language; improve the prompt without translating it.";

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

  test("preserves the user's language for every improvement strategy", () => {
    for (const strategy of CHAT_PROMPT_IMPROVEMENT_STRATEGIES) {
      const modelInput = buildPromptImprovementModelInput(
        "Zkontrolujte tuto smlouvu",
        strategy,
      );

      expect(modelInput.system.startsWith(LEGAL_CONTEXT_PREFIX)).toBe(true);
      expect(modelInput.system).toContain(
        "Write in the same language as the draft.",
      );
      expect(modelInput.messages).toHaveLength(1);
      expect(modelInput.messages.at(0)?.content).toContain(
        '"draft":"Zkontrolujte tuto smlouvu"',
      );
    }
  });
});
