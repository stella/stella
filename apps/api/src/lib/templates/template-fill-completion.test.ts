import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import type { AiFieldError } from "@/api/lib/docx/resolve-ai-fields";
import {
  decideTemplateFillCompletion,
  TEMPLATE_FILL_COMPLETION_MODES,
} from "@/api/lib/templates/template-fill-completion";

const aiFieldErrorArbitrary = fc.record({
  fieldPath: fc.string({ minLength: 1 }),
  valuePath: fc.string({ minLength: 1 }),
  itemIndex: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
  reason: fc.constantFrom<AiFieldError["reason"]>(
    "empty",
    "generation-failed",
    "interrupted",
    "truncated",
  ),
  message: fc.string({ minLength: 1 }),
});

type ExpectedNonemptyShortfall =
  | {
      unmatchedPlaceholders: readonly [string, ...string[]];
      aiFieldErrors: readonly AiFieldError[];
    }
  | {
      unmatchedPlaceholders: readonly [];
      aiFieldErrors: readonly [AiFieldError, ...AiFieldError[]];
    };

describe("template fill completion policy", () => {
  test("accepts exactly complete fills by default and partial fills by explicit policy", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { maxLength: 30 }),
        fc.array(aiFieldErrorArbitrary, { maxLength: 10 }),
        fc.constantFrom(...TEMPLATE_FILL_COMPLETION_MODES),
        (unmatchedPlaceholders, aiFieldErrors, mode) => {
          const decision = decideTemplateFillCompletion({
            mode,
            unmatchedPlaceholders,
            aiFieldErrors,
          });

          if (
            unmatchedPlaceholders.length === 0 &&
            aiFieldErrors.length === 0
          ) {
            expect(decision).toEqual({ type: "complete" });
            return;
          }

          expect(decision.type).toBe(
            mode === "allow_partial" ? "accepted_partial" : "rejected_partial",
          );
          if (decision.type === "complete") {
            throw new Error("a reported shortfall cannot be complete");
          }
          const staticallyNonempty: ExpectedNonemptyShortfall = decision;
          expect(
            staticallyNonempty.unmatchedPlaceholders.length > 0 ||
              staticallyNonempty.aiFieldErrors.length > 0,
          ).toBe(true);
          expect([...decision.unmatchedPlaceholders]).toEqual(
            unmatchedPlaceholders,
          );
          expect([...decision.aiFieldErrors]).toEqual(aiFieldErrors);
        },
      ),
      propertyConfig(),
    );
  });

  test("a failed AI draft alone makes a fill incomplete", () => {
    const aiFieldErrors: AiFieldError[] = [
      {
        fieldPath: "scope",
        valuePath: "scope",
        itemIndex: null,
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      },
    ];

    expect(
      decideTemplateFillCompletion({
        mode: "require_complete",
        unmatchedPlaceholders: [],
        aiFieldErrors,
      }).type,
    ).toBe("rejected_partial");
    expect(
      decideTemplateFillCompletion({
        mode: "allow_partial",
        unmatchedPlaceholders: [],
        aiFieldErrors,
      }).type,
    ).toBe("accepted_partial");
  });
});
