import { describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";

import {
  DECISION_HEADNOTE_TRUNCATION_MARK,
  type DecisionHeadnotePreview,
} from "@stll/api-contract/case-law-text-field";

import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import { LIMITS } from "@/api/lib/limits";

describe("decision headnote preview response schema", () => {
  test("matches the shared contract", () => {
    // `branded` compares structure: the contract's present branch is an
    // intersection, which the strict identity check never equates with the
    // flat object the schema infers.
    expectTypeOf<
      v.InferOutput<typeof decisionHeadnotePreviewSchema>
    >().branded.toEqualTypeOf<DecisionHeadnotePreview>();
  });

  test.each([
    { type: "present", text: "Complete preview", truncated: false },
    {
      type: "present",
      text: `Bounded preview${DECISION_HEADNOTE_TRUNCATION_MARK}`,
      truncated: true,
    },
    { type: "absent", reason: "not_published" },
    { type: "keywords", items: ["Nájem", "Výpověď"], omitted: 0 },
    {
      type: "keywords",
      items: Array.from(
        { length: LIMITS.caseLawHeadnoteKeywords },
        (_, index) => `Term ${String(index)}`,
      ),
      omitted: 3,
    },
  ])("accepts a declared branch", (headnote) => {
    expect(v.is(decisionHeadnotePreviewSchema, headnote)).toBe(true);
  });

  test.each([
    null,
    "raw headnote",
    { type: "present", text: "Ambiguous preview" },
    { type: "present", text: "", truncated: false },
    {
      type: "present",
      // The bound is in UTF-8 bytes: four per stored character.
      text: "x".repeat(LIMITS.caseLawHeadnoteMaxChars * 4 + 1),
      truncated: true,
    },
    { type: "absent", reason: "unknown" },
    { type: "keywords", items: [], omitted: 0 },
    { type: "keywords", items: ["Nájem"] },
    { type: "keywords", items: "Nájem", omitted: 0 },
    { type: "keywords", items: ["Nájem"], omitted: -1 },
    { type: "keywords", items: ["Nájem"], omitted: 1.5 },
    {
      type: "keywords",
      items: Array.from(
        { length: LIMITS.caseLawHeadnoteKeywords + 1 },
        (_, index) => `Term ${String(index)}`,
      ),
      omitted: 0,
    },
  ])("rejects an ambiguous or invalid preview", (headnote) => {
    expect(v.is(decisionHeadnotePreviewSchema, headnote)).toBe(false);
  });

  test.each([
    {
      sent: {
        type: "present",
        text: "Preview",
        truncated: false,
        reason: "parse_failed",
      },
      wire: { type: "present", text: "Preview", truncated: false },
    },
    {
      sent: { type: "absent", reason: "not_published", truncated: false },
      wire: { type: "absent", reason: "not_published" },
    },
  ])("a field of another branch never reaches the wire", ({ sent, wire }) => {
    // A response is sent as its schema's output, so one branch cannot carry
    // another's fields and read as both.
    expect(v.parse(decisionHeadnotePreviewSchema, sent)).toEqual(wire);
  });
});
