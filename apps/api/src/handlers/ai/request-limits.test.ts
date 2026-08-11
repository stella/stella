import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { OUTLOOK_AI_INPUT_MAX_CHARS } from "@stll/api-contract";

import draftEmail from "@/api/handlers/ai/draft-email";
import summarizeEmail from "@/api/handlers/ai/summarize";

describe("Outlook AI request limits", () => {
  test("accepts summary text at the boundary and rejects overlong text", () => {
    const text = "a".repeat(OUTLOOK_AI_INPUT_MAX_CHARS);

    expect(Value.Check(summarizeEmail.config.body, { text })).toBe(true);
    expect(Value.Check(summarizeEmail.config.body, { text: `${text}b` })).toBe(
      false,
    );
  });

  test("accepts draft body at the boundary and rejects overlong body", () => {
    const originalBody = "a".repeat(OUTLOOK_AI_INPUT_MAX_CHARS);
    const request = { intent: "Reply", originalBody };

    expect(Value.Check(draftEmail.config.body, request)).toBe(true);
    expect(
      Value.Check(draftEmail.config.body, {
        ...request,
        originalBody: `${originalBody}b`,
      }),
    ).toBe(false);
  });
});
