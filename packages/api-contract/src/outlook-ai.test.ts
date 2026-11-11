import { describe, expect, test } from "bun:test";

import {
  OUTLOOK_AI_INPUT_MAX_CHARS,
  parseOutlookAIDraftResponse,
  parseOutlookAISummaryResponse,
  truncateOutlookAIInput,
} from "./outlook-ai";

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

describe("Outlook AI responses", () => {
  test("a summary response carries its text", () => {
    const parsed = parseOutlookAISummaryResponse({
      summary: "- Deadline 5 May",
    });

    expect(parsed.success && parsed.output).toEqual({
      summary: "- Deadline 5 May",
    });
    expect(parseOutlookAISummaryResponse({ draft: "Hi" }).success).toBe(false);
  });

  test("a draft response carries its text", () => {
    const parsed = parseOutlookAIDraftResponse({ draft: "Dear Ms Novak," });

    expect(parsed.success && parsed.output).toEqual({
      draft: "Dear Ms Novak,",
    });
    expect(parseOutlookAIDraftResponse({ summary: "Hi" }).success).toBe(false);
  });
});
