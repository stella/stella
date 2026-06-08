import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { fieldSuggestionsSchema } from "./suggest-template-fields";

describe("fieldSuggestionsSchema", () => {
  test("accepts well-formed suggestions (plain, typed, and AI-fillable)", () => {
    const result = v.safeParse(fieldSuggestionsSchema, {
      suggestions: [
        {
          literalText: "Jan Kowalski",
          fieldPath: "signatory.name",
          inputType: "text",
        },
        {
          literalText: "registration matters",
          fieldPath: "scope",
          aiPrompt: "Draft the scope of this power of attorney",
        },
        {
          literalText: "ROKA NIERUCHOMOŚCI Sp. z o.o.",
          fieldPath: "company.name",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an unknown inputType and a missing fieldPath", () => {
    expect(
      v.safeParse(fieldSuggestionsSchema, {
        suggestions: [{ literalText: "x", fieldPath: "p", inputType: "bogus" }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(fieldSuggestionsSchema, {
        suggestions: [{ literalText: "x" }],
      }).success,
    ).toBe(false);
  });
});
