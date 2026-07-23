import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  decideTemplateFillCompletion,
  TEMPLATE_FILL_COMPLETION_MODES,
} from "@/api/handlers/templates/template-fill-completion";

describe("template fill completion policy", () => {
  test("accepts exactly complete fills by default and partial fills by explicit policy", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { maxLength: 30 }),
        fc.constantFrom(...TEMPLATE_FILL_COMPLETION_MODES),
        (unmatchedPlaceholders, mode) => {
          const decision = decideTemplateFillCompletion({
            mode,
            unmatchedPlaceholders,
          });

          if (unmatchedPlaceholders.length === 0) {
            expect(decision).toEqual({ type: "complete" });
            return;
          }

          expect(decision.type).toBe(
            mode === "allow_partial" ? "accepted_partial" : "rejected_partial",
          );
          if (decision.type === "complete") {
            throw new Error("a non-empty placeholder list cannot be complete");
          }
          expect([...decision.unmatchedPlaceholders]).toEqual(
            unmatchedPlaceholders,
          );
          expect(decision.unmatchedPlaceholders.length).toBeGreaterThan(0);
        },
      ),
      propertyConfig(),
    );
  });
});
