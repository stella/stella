/**
 * Grading against a reference standard. The model classifies and locates; the
 * verdict, the impact of a quantity, and the fix are all derived here, so
 * these tests are about the derivation and the grounding it refuses to skip.
 */

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
import {
  ASSESSMENT_VERDICTS,
  normalizeReferenceGrading,
  REFERENCE_ASSESSMENTS,
  referenceGradeSchema,
} from "@/api/lib/document-review/reference-grade";
import type { ReferenceStandardPosition } from "@/api/lib/document-review/reference-grade";
import { deriveParameterImpact } from "@/api/lib/document-review/review-delta";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";
import { VERDICT_TIERS } from "@/api/lib/workflow/verdict-tiers";

const POSITION_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_BLOCK = "Claims must be notified within 12 months of Completion.";
const STANDARD_BLOCK = "Claims must be notified within 6 months of Completion.";

const targetBlocks = new Map([["p-1", TARGET_BLOCK]]);

const position: ReferenceStandardPosition = {
  sourceId: POSITION_ID,
  issue: "Claims time bar",
  passages: [
    {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      entityId: "33333333-3333-4333-8333-333333333333",
      fileFieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
      entityVersionId: "55555555-5555-4555-8555-555555555555",
      blockId: "r-9",
      text: STANDARD_BLOCK,
    },
  ],
};

const buyer: ReviewPerspective = { type: "party", role: "Buyer", name: null };

const emptyDelta = {
  kind: "language" as const,
  targetValue: null,
  standardValue: null,
  items: [],
  term: "",
  inTarget: false,
  inStandard: false,
};

const raw = (overrides: Record<string, unknown> = {}) => ({
  positionId: POSITION_ID,
  assessment: "different" as const,
  consensus: "single" as const,
  rationale: "The target allows twice as long.",
  recommendation: "Shorten the notification period to six months.",
  impact: "unknown" as const,
  direction: "lower-favours-target-side" as const,
  delta: emptyDelta,
  proposedText: null,
  targetCitations: [{ blockId: "p-1" }],
  ...overrides,
});

describe("referenceGradeSchema", () => {
  // The schema is handed to the provider as JSON Schema; a valibot action with
  // no JSON Schema form only fails at request time.
  test("converts to provider JSON Schema", () => {
    const schema = toTanStackValibotSchema(referenceGradeSchema);
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(json).toMatchObject({ type: "object" });
  });
});

describe("ASSESSMENT_VERDICTS", () => {
  test("maps every assessment onto a verdict in the one vocabulary", () => {
    for (const assessment of REFERENCE_ASSESSMENTS) {
      expect(VERDICT_TIERS).toContain(ASSESSMENT_VERDICTS[assessment]);
    }
    expect(Object.keys(ASSESSMENT_VERDICTS).toSorted()).toEqual(
      [...REFERENCE_ASSESSMENTS].toSorted(),
    );
  });
});

describe("deriveParameterImpact", () => {
  const delta = (target: number | null, standard: number | null) =>
    ({
      kind: "parameter" as const,
      target:
        target === null
          ? null
          : {
              text: `${String(target)} months`,
              value: target,
              unit: "months",
              citation: { blockId: "p-1", text: TARGET_BLOCK },
            },
      standard:
        standard === null
          ? null
          : {
              text: `${String(standard)} months`,
              value: standard,
              unit: "months",
              citation: { blockId: "r-9", text: STANDARD_BLOCK },
            },
    }) as const;

  test("a longer period is favourable when lower favours the other way", () => {
    expect(
      deriveParameterImpact({
        direction: "higher-favours-target-side",
        delta: delta(12, 6),
        perspective: buyer,
      }),
    ).toBe("favourable");
    expect(
      deriveParameterImpact({
        direction: "lower-favours-target-side",
        delta: delta(12, 6),
        perspective: buyer,
      }),
    ).toBe("unfavourable");
  });

  test("equal values cut neither way", () => {
    expect(
      deriveParameterImpact({
        direction: "lower-favours-target-side",
        delta: delta(6, 6),
        perspective: buyer,
      }),
    ).toBe("neutral");
  });

  test("no named side, no direction, and a missing number are all unknown", () => {
    expect(
      deriveParameterImpact({
        direction: "lower-favours-target-side",
        delta: delta(12, 6),
        perspective: { type: "neutral" },
      }),
    ).toBe("unknown");
    expect(
      deriveParameterImpact({
        direction: "unknown",
        delta: delta(12, 6),
        perspective: buyer,
      }),
    ).toBe("unknown");
    expect(
      deriveParameterImpact({
        direction: "lower-favours-target-side",
        delta: delta(12, null),
        perspective: buyer,
      }),
    ).toBe("unknown");
  });

  // "6 months" and "6 years" are both 6; comparing them would invent a
  // conclusion the documents do not support.
  test("mismatched units are unknown", () => {
    const mixed = delta(6, 12);
    expect(
      deriveParameterImpact({
        direction: "lower-favours-target-side",
        delta: {
          kind: "parameter",
          target: mixed.target,
          standard:
            mixed.standard === null
              ? null
              : { ...mixed.standard, unit: "years" },
        },
        perspective: buyer,
      }),
    ).toBe("unknown");
  });
});

describe("normalizeReferenceGrading", () => {
  test("maps the assessment to a verdict and grounds a parameter fix", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({
        delta: {
          ...emptyDelta,
          kind: "parameter",
          targetValue: {
            text: "12 months",
            value: 12,
            unit: "months",
            blockId: "p-1",
          },
          standardValue: {
            text: "6 months",
            value: 6,
            unit: "months",
            blockId: "r-9",
          },
        },
      }),
      position,
      targetBlocks,
      perspective: buyer,
    });

    expect(grading.verdict).toBe("deviation");
    expect(grading.delta.kind).toBe("parameter");
    expect(grading.impact).toBe("unfavourable");
    expect(grading.fix).toEqual({
      kind: "replaceInBlock",
      blockId: "p-1",
      find: "12 months",
      replace: "6 months",
    });
    expect(grading.referenceCitations).toEqual([
      {
        fileFieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
        citations: [{ blockId: "r-9", text: STANDARD_BLOCK }],
      },
    ]);
  });

  // A structured claim the documents cannot locate is still a real difference;
  // it just stops being one the engine can point at term by term.
  test("an unlocatable parameter degrades to a language delta", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({
        delta: {
          ...emptyDelta,
          kind: "parameter",
          targetValue: {
            text: "12 months",
            value: 12,
            unit: "months",
            blockId: "nope",
          },
          standardValue: {
            text: "6 months",
            value: 6,
            unit: "months",
            blockId: "nope",
          },
        },
      }),
      position,
      targetBlocks,
      perspective: buyer,
    });

    expect(grading.delta).toEqual({ kind: "language" });
  });

  test("a conclusion about the target with nothing cited is not comparable", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({ targetCitations: [{ blockId: "unknown-block" }] }),
      position,
      targetBlocks,
      perspective: buyer,
    });

    expect(grading.verdict).toBe("not-applicable");
    expect(grading.explanation).toEqual({ type: "insufficient-evidence" });
    expect(grading.fix).toBeNull();
  });

  // The evidence for an omission is the standard; the target has nothing to
  // quote, so the finding still stands.
  test("a missing clause is grounded by the standard alone", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({ assessment: "missing-from-target", targetCitations: [] }),
      position,
      targetBlocks,
      perspective: buyer,
    });

    expect(grading.verdict).toBe("missing");
    expect(grading.explanation.type).toBe("comparison");
  });

  test("no named side reports no impact, whatever the model said", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({ impact: "unfavourable" }),
      position,
      targetBlocks,
      perspective: { type: "neutral" },
    });

    expect(grading.impact).toBe("unknown");
  });
});
