import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { fieldSuggestionsSchema } from "./suggest-template-fields";

describe("fieldSuggestionsSchema", () => {
  test("accepts well-formed suggestions (plain, typed, and AI-fillable)", () => {
    // Strict-mode structured output makes every property required; "absent"
    // is modelled as an explicit null (see the schema comment), so these
    // payloads carry the nulls a strict-mode model actually emits.
    const result = v.safeParse(fieldSuggestionsSchema, {
      suggestions: [
        {
          literalText: "Jan Kowalski",
          fieldPath: "signatory.name",
          inputType: "text",
          label: null,
          hint: "As printed on the signatory's ID",
          exampleValue: null,
          aiPrompt: null,
        },
        {
          literalText: "registration matters",
          fieldPath: "scope",
          inputType: null,
          label: null,
          hint: null,
          exampleValue: null,
          aiPrompt: "Draft the scope of this power of attorney",
        },
        {
          literalText: "ROKA NIERUCHOMOŚCI Sp. z o.o.",
          fieldPath: "company.name",
          inputType: null,
          label: null,
          hint: null,
          exampleValue: null,
          aiPrompt: null,
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
