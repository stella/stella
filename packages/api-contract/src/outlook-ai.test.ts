import { describe, expect, test } from "bun:test";

import {
  OUTLOOK_AI_INPUT_MAX_CHARS,
  parseOutlookAIAskResponse,
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

  test("an answer carries its text and the documents it cites", () => {
    const response = {
      answer: "The cap is 30 % of the price [1].",
      sources: [
        {
          number: 1,
          entityId: "0a6f3c1e-6c55-4b8e-9f43-2b1d7c9a3001",
          workspaceId: "0a6f3c1e-6c55-4b8e-9f43-2b1d7c9a1002",
          fieldId: null,
          title: "SPA v2",
        },
      ],
    };
    const parsed = parseOutlookAIAskResponse(response);

    expect(parsed.success && parsed.output).toEqual(response);
    expect(parseOutlookAIAskResponse({ answer: "Hi" }).success).toBe(false);
    expect(
      parseOutlookAIAskResponse({
        answer: "Hi",
        sources: [{ ...response.sources[0], number: 0 }],
      }).success,
    ).toBe(false);
  });
});
