import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, test } from "bun:test";
import type { Static } from "elysia";

import {
  DECISION_HEADNOTE_TRUNCATION_MARK,
  type DecisionHeadnotePreview,
} from "@stll/api-contract/case-law-text-field";

import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import { LIMITS } from "@/api/lib/limits";

describe("decision headnote preview response schema", () => {
  test("matches the shared contract", () => {
    expectTypeOf<
      Static<typeof decisionHeadnotePreviewSchema>
    >().toEqualTypeOf<DecisionHeadnotePreview>();
  });

  test.each([
    { type: "present", text: "Complete preview", truncated: false },
    {
      type: "present",
      text: `Bounded preview${DECISION_HEADNOTE_TRUNCATION_MARK}`,
      truncated: true,
    },
    { type: "absent", reason: "not_published" },
  ])("accepts a declared branch", (headnote) => {
    expect(Value.Check(decisionHeadnotePreviewSchema, headnote)).toBe(true);
  });

  test.each([
    null,
    "raw headnote",
    { type: "present", text: "Ambiguous preview" },
    { type: "present", text: "", truncated: false },
    {
      type: "present",
      text: "x".repeat(LIMITS.caseLawHeadnoteMaxChars + 1),
      truncated: true,
    },
    {
      type: "present",
      text: "Preview",
      truncated: false,
      reason: "parse_failed",
    },
    { type: "absent", reason: "not_published", truncated: false },
    { type: "absent", reason: "unknown" },
  ])("rejects an ambiguous or invalid preview", (headnote) => {
    expect(Value.Check(decisionHeadnotePreviewSchema, headnote)).toBe(false);
  });
});
