import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  fieldSuggestionsSchema,
  toSuggestFieldsError,
} from "./suggest-template-fields";

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

describe("toSuggestFieldsError", () => {
  test("a typed HandlerError passes through with its status and message", () => {
    const typed = new HandlerError({
      status: 403,
      message: "AI is not available for this role",
    });
    expect(toSuggestFieldsError(typed)).toBe(typed);
  });

  test("an untyped failure becomes a 500", () => {
    const mapped = toSuggestFieldsError(new Error("socket hang up"));
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe("Failed to suggest template fields");
  });
});

describe("toSuggestFieldsError provider-run errors", () => {
  test("a 5xx HandlerError is remapped to the generic 500", () => {
    const providerRun = new HandlerError({
      status: 502,
      message: "provider text that could echo request content",
    });
    const mapped = toSuggestFieldsError(providerRun);
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe("Failed to suggest template fields");
  });
});
