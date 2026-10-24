import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";

import {
  decisionSummaryResponseSchema,
  projectDecisionSummary,
} from "./summary-response";

const summaryWithText = (text: string) => ({
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000001"),
  caseNumber: text,
  court: text,
  courtAbbreviation: text,
  courtTier: "other" as const,
  decisionDate: text,
  decisionType: text,
  headnote: { type: "absent" as const, reason: "not_published" as const },
  citationCount: 17,
  publication: text,
});

test("stored decision summaries satisfy their wire bounds and projection is idempotent", () => {
  const text = fc
    .array(fc.constantFrom("a", "Ž", "😀", "\ud800"), {
      minLength: 1025,
      maxLength: 2049,
    })
    .map((characters) => characters.join(""));
  assertProperty(
    "stored decision summaries satisfy their wire bounds and projection is idempotent",
    fc.property(text, (raw) => {
      const input = summaryWithText(raw);
      expect(Value.Check(decisionSummaryResponseSchema, input)).toBe(false);
      const projected = projectDecisionSummary(input);
      expect(
        Value.Errors(decisionSummaryResponseSchema, projected).First(),
      ).toBeUndefined();
      expect(projectDecisionSummary(projected)).toEqual(projected);
      expect(projected.citationCount).toBe(input.citationCount);
    }),
  );
});

test("a summary keeps absent stored facts absent", () => {
  const input = {
    ...summaryWithText("Case"),
    courtAbbreviation: null,
    decisionDate: null,
    decisionType: null,
    publication: null,
  };
  expect(projectDecisionSummary(input)).toEqual(input);
});
