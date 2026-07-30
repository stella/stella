import { describe, expect, test } from "bun:test";

import {
  buildSuggestPromptUserMessage,
  SUGGEST_PROMPT_SYSTEM_PROMPT,
} from "./suggest-prompt-message";

describe("suggest prompt language", () => {
  test("uses the column name's language for a new prompt", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Odpovědnost jednatele",
      contentType: "text",
      options: undefined,
      currentPrompt: undefined,
    });

    expect(message).toContain(
      "Output language: Match the column name's language.",
    );
  });

  test("uses the current draft's language when refining a prompt", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Executive liability",
      contentType: "text",
      options: undefined,
      currentPrompt: "Popište rozsah odpovědnosti jednatele.",
    });

    expect(message).toContain(
      "Output language: Match the current draft's language.",
    );
  });

  test("prevents the English instructions from becoming the output default", () => {
    expect(SUGGEST_PROMPT_SYSTEM_PROMPT).toContain(
      "English merely because these instructions are in English.",
    );
  });
});
