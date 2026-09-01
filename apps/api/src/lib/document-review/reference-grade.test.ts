/**
 * Grading against a reference standard. The model classifies and locates; the
 * kind of difference comes from the position, and the verdict, the impact of a
 * quantity, and the fix are all derived here — so these tests are about the
 * derivation and the grounding it refuses to skip.
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
import {
  deriveParameterImpact,
  EXPECTED_DELTA_KIND,
} from "@/api/lib/document-review/review-delta";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";
import { POSITION_TERM_KINDS } from "@/api/lib/workflow/playbook-positions";
import type { PositionTermKind } from "@/api/lib/workflow/playbook-positions";
import { VERDICT_TIERS } from "@/api/lib/workflow/verdict-tiers";

const POSITION_ID = "11111111-1111-4111-8111-111111111111";
const PASSAGE_ID = "66666666-6666-4666-8666-666666666666";
const TARGET_BLOCK =
  "Claims must be notified within 12 (twelve) months of Completion.";
const STANDARD_BLOCK =
  "Claims must be notified within 6 (six) months of Completion.";
/** The same term twice: no fix can say which occurrence it means. */
const AMBIGUOUS_TARGET_BLOCK =
  "Claims must be notified within 12 (twelve) months, and any claim not notified within 12 (twelve) months lapses.";

const targetBlocks = new Map([
  ["p-1", TARGET_BLOCK],
  ["p-2", AMBIGUOUS_TARGET_BLOCK],
]);

const position = (
  termKind: PositionTermKind = "parameter",
): ReferenceStandardPosition => ({
  sourceId: POSITION_ID,
  issue: "Time-bar: general warranty claims",
  termKind,
  passages: [
    {
      id: PASSAGE_ID,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      entityId: "33333333-3333-4333-8333-333333333333",
      fileFieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
      entityVersionId: "55555555-5555-4555-8555-555555555555",
      blockId: "r-9",
      text: STANDARD_BLOCK,
    },
  ],
});

const buyer: ReviewPerspective = { type: "party", role: "Buyer", name: null };

const emptyDelta = {
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
          targetValue: {
            text: "12 (twelve) months",
            value: 12,
            unit: "months",
            blockId: "p-1",
          },
          standardValue: {
            text: "6 (six) months",
            value: 6,
            unit: "months",
            blockId: "r-9",
          },
        },
      }),
      position: position("parameter"),
      targetBlocks,
      targetLanguage: "EN-GB",
      perspective: buyer,
    });

    expect(grading.verdict).toBe("deviation");
    expect(grading.delta.kind).toBe("parameter");
    expect(grading.impact).toBe("unfavourable");
    // The term is replaced, not the paragraph, and `find` is the phrase the
    // block actually writes.
    expect(grading.fix).toEqual({
      kind: "replaceInBlock",
      blockId: "p-1",
      find: "12 (twelve) months",
      replace: "6 (six) months",
    });
    expect(TARGET_BLOCK).toContain("12 (twelve) months");
    expect(grading.referenceCitations).toEqual([
      {
        fileFieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
        passages: [{ id: PASSAGE_ID, blockId: "r-9" }],
      },
    ]);
  });

  // The position says what kind of term it is. An answer that fits another
  // kind is not a different finding; it is a claim about a term this position
  // is not about, and the delta is decided by the position either way.
  test("the position's term kind decides the delta kind, not the answer", () => {
    const answerForEveryKind = {
      ...emptyDelta,
      targetValue: {
        text: "12 (twelve) months",
        value: 12,
        unit: "months",
        blockId: "p-1",
      },
      standardValue: {
        text: "6 (six) months",
        value: 6,
        unit: "months",
        blockId: "r-9",
      },
      items: [
        {
          label: "Dividends",
          inTarget: false,
          inStandard: true,
          blockId: null,
        },
      ],
      term: "Losses",
      inTarget: false,
      inStandard: true,
    };

    for (const termKind of POSITION_TERM_KINDS) {
      const grading = normalizeReferenceGrading({
        raw: raw({ delta: answerForEveryKind }),
        position: position(termKind),
        targetBlocks,
        targetLanguage: "EN-GB",
        perspective: buyer,
      });

      expect(grading.delta.kind).toBe(EXPECTED_DELTA_KIND[termKind]);
    }
  });

  // A structured claim the documents cannot locate is still a real difference;
  // it just stops being one the engine can point at term by term. The one
  // degradation is `language`, never another structured kind.
  test("an unlocatable parameter degrades to a language delta and no fix", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({
        proposedText: "Claims must be notified within 6 (six) months.",
        delta: {
          ...emptyDelta,
          targetValue: {
            text: "12 (twelve) months",
            value: 12,
            unit: "months",
            blockId: "nope",
          },
          standardValue: {
            text: "6 (six) months",
            value: 6,
            unit: "months",
            blockId: "nope",
          },
        },
      }),
      position: position("parameter"),
      targetBlocks,
      targetLanguage: "EN-GB",
      perspective: buyer,
    });

    expect(grading.delta).toEqual({ kind: "language" });
    // A number we could not find is not a licence to rewrite the clause it
    // was supposed to be in.
    expect(grading.fix).toBeNull();
  });

  // The same rule for every structured kind: a term the documents could not
  // support is never upgraded into a whole-block replacement.
  test("a degraded structured delta never becomes a block rewrite", () => {
    for (const termKind of POSITION_TERM_KINDS) {
      const grading = normalizeReferenceGrading({
        raw: raw({
          proposedText: "Losses means all losses, damages and costs.",
          delta: emptyDelta,
        }),
        position: position(termKind),
        targetBlocks,
        targetLanguage: "EN-GB",
        perspective: buyer,
      });

      expect(grading.delta).toEqual({ kind: "language" });
      if (termKind === "language") {
        // A wording standard IS a whole-block claim, so this one may edit.
        expect(grading.fix).toEqual({
          kind: "replaceBlock",
          blockId: "p-1",
          text: "Losses means all losses, damages and costs.",
        });
        continue;
      }
      expect(grading.fix).toBeNull();
    }
  });

  // A term stated twice in one block cannot be replaced without saying which
  // occurrence the finding is about, and an editor must.
  test("an ambiguous term produces no fix", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({
        delta: {
          ...emptyDelta,
          targetValue: {
            text: "12 (twelve) months",
            value: 12,
            unit: "months",
            blockId: "p-2",
          },
          standardValue: {
            text: "6 (six) months",
            value: 6,
            unit: "months",
            blockId: "r-9",
          },
        },
        targetCitations: [{ blockId: "p-2" }],
      }),
      position: position("parameter"),
      targetBlocks,
      targetLanguage: "EN-GB",
      perspective: buyer,
    });

    expect(grading.fix).toBeNull();
  });

  // The clause serves a different function in the target: saying so is the
  // finding, and pasting the standard's wording over it is not.
  test("a clause that is not comparable never becomes an edit", () => {
    for (const assessment of ["deal-specific", "not-comparable"] as const) {
      const grading = normalizeReferenceGrading({
        raw: raw({
          assessment,
          proposedText: "Disclosure must be fair and in sufficient detail.",
        }),
        position: position("language"),
        targetBlocks,
        targetLanguage: "EN-GB",
        perspective: buyer,
      });

      expect(grading.verdict).toBe("not-applicable");
      expect(grading.fix).toBeNull();
    }
  });

  test("an aligned target is not handed an edit either", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({
        assessment: "aligned",
        proposedText: "Disclosure must be fair and in sufficient detail.",
      }),
      position: position("language"),
      targetBlocks,
      targetLanguage: "EN-GB",
      perspective: buyer,
    });

    expect(grading.verdict).toBe("compliant");
    expect(grading.fix).toBeNull();
  });

  test("a conclusion about the target with nothing cited is not comparable", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({ targetCitations: [{ blockId: "unknown-block" }] }),
      position: position(),
      targetBlocks,
      targetLanguage: "EN-GB",
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
      position: position(),
      targetBlocks,
      targetLanguage: "EN-GB",
      perspective: buyer,
    });

    expect(grading.verdict).toBe("missing");
    expect(grading.explanation.type).toBe("comparison");
  });

  test("no named side reports no impact, whatever the model said", () => {
    const grading = normalizeReferenceGrading({
      raw: raw({ impact: "unfavourable" }),
      position: position("language"),
      targetBlocks,
      targetLanguage: "EN-GB",
      perspective: { type: "neutral" },
    });

    expect(grading.impact).toBe("unknown");
  });
});
