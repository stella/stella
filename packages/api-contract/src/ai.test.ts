import { describe, expect, test } from "bun:test";

import { OUTLOOK_AI_INPUT_MAX_CHARS, truncateOutlookAIInput } from "./ai";

describe("Outlook AI input boundary", () => {
  test("preserves input at the boundary", () => {
    const input = "a".repeat(OUTLOOK_AI_INPUT_MAX_CHARS);

    expect(truncateOutlookAIInput(input)).toBe(input);
  });

  test("truncates input beyond the boundary", () => {
    const input = "a".repeat(OUTLOOK_AI_INPUT_MAX_CHARS + 1);

    expect(truncateOutlookAIInput(input)).toBe(
      "a".repeat(OUTLOOK_AI_INPUT_MAX_CHARS),
    );
  });
});
