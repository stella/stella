/**
 * The fingerprint decides whether a reviewer's decision survives a re-run, so
 * the tests are about what it must and must not react to: the conclusion and
 * the quoted evidence, not the wording around them and not where a paragraph
 * happens to sit in the file.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { findingFingerprint } from "@/api/lib/document-review/finding-fingerprint";
import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";

type FindingPayload = DocumentReviewFindingPayload;
type Finding = FindingPayload["finding"];

const POSITION_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE_POSITION_ID = "44444444-4444-4444-8444-444444444444";
const REFERENCE_FIELD_A = toSafeId<"field">(
  "22222222-2222-4222-8222-222222222222",
);
const REFERENCE_FIELD_B = toSafeId<"field">(
  "33333333-3333-4333-8333-333333333333",
);
const REFERENCE_PASSAGE_A = "55555555-5555-4555-8555-555555555555";
const REFERENCE_PASSAGE_B = "66666666-6666-4666-8666-666666666666";

const playbookPayload = (overrides: Partial<Finding> = {}): FindingPayload => ({
  finding: {
    positionId: POSITION_ID,
    issue: "Governing law",
    severity: "high",
    standardSource: "tiers",
    verdict: "compliant",
    delta: { kind: "language" },
    extracted: { value: "England and Wales", text: "governed by English law" },
    rationale: "Matches the standard.",
    citations: [{ blockId: "para-7", text: "This Agreement is governed by" }],
    fix: null,
    ...overrides,
  },
});

const referencePayload = (
  overrides: Partial<Finding> = {},
): FindingPayload => ({
  finding: {
    positionId: REFERENCE_POSITION_ID,
    issue: "Governing law",
    severity: "high",
    standardSource: "reference",
    verdict: "deviation",
    delta: { kind: "language" },
    extracted: null,
    consensus: "single",
    rationale: "The target picks a new forum.",
    explanation: { type: "comparison", text: "The target picks a new forum." },
    citations: [{ blockId: "para-7", text: "governed by English law" }],
    referenceCitations: [
      {
        fileFieldId: REFERENCE_FIELD_A,
        passages: [{ id: REFERENCE_PASSAGE_A, blockId: "para-9" }],
      },
    ],
    fix: null,
    ...overrides,
  },
});

describe("findingFingerprint", () => {
  test("is stable for an identical finding", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).toBe(
      findingFingerprint(playbookPayload(), "compliant"),
    );
  });

  // Two findings that quote different passages are about different text, even
  // when they reach the same verdict.
  test("separates findings resting on different evidence", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).not.toBe(
      findingFingerprint(referencePayload(), "compliant"),
    );
  });

  // The delta is how a difference is rendered and edited, not what the
  // documents say; retyping it must not reopen a settled decision.
  test("ignores the delta's typing", () => {
    expect(findingFingerprint(referencePayload(), "deviation")).toBe(
      findingFingerprint(
        referencePayload({
          delta: {
            kind: "presence",
            term: "Losses",
            inTarget: false,
            inStandard: true,
          },
        }),
        "deviation",
      ),
    );
  });

  test("changes when the outcome changes", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).not.toBe(
      findingFingerprint(playbookPayload(), "deviation"),
    );
  });

  test("changes when the extracted value changes", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).not.toBe(
      findingFingerprint(
        playbookPayload({
          extracted: { value: "New York", text: "governed by English law" },
        }),
        "compliant",
      ),
    );
  });

  test("changes when a cited excerpt changes", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).not.toBe(
      findingFingerprint(
        playbookPayload({
          citations: [
            {
              blockId: "para-7",
              text: "This Agreement is governed by Delaware",
            },
          ],
        }),
        "compliant",
      ),
    );
  });

  test("changes when evidence is added", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).not.toBe(
      findingFingerprint(
        playbookPayload({
          citations: [
            { blockId: "para-7", text: "This Agreement is governed by" },
            { blockId: "para-8", text: "and the courts of England" },
          ],
        }),
        "compliant",
      ),
    );
  });

  // A block id is a `w14:paraId` where the DOCX carries one and a positional
  // `seq-NNNN` otherwise, so inserting an unrelated paragraph renumbers
  // untouched ones. Reacting to that would reopen decisions about text nobody
  // edited.
  test("ignores the block id an excerpt was cited under", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).toBe(
      findingFingerprint(
        playbookPayload({
          citations: [
            { blockId: "seq-0042", text: "This Agreement is governed by" },
          ],
        }),
        "compliant",
      ),
    );
  });

  test("ignores model prose around the same conclusion", () => {
    expect(findingFingerprint(playbookPayload(), "compliant")).toBe(
      findingFingerprint(
        playbookPayload({ rationale: "Phrased differently this run." }),
        "compliant",
      ),
    );
  });

  test("ignores citation order but not citation content", () => {
    const forward = referencePayload({
      citations: [
        { blockId: "para-7", text: "first passage" },
        { blockId: "para-8", text: "second passage" },
      ],
    });
    const reversed = referencePayload({
      citations: [
        { blockId: "para-8", text: "second passage" },
        { blockId: "para-7", text: "first passage" },
      ],
    });
    expect(findingFingerprint(forward, "deviation")).toBe(
      findingFingerprint(reversed, "deviation"),
    );
  });

  test("keeps evidence attributed to the reference document it came from", () => {
    const moved = referencePayload({
      referenceCitations: [
        {
          fileFieldId: REFERENCE_FIELD_B,
          passages: [{ id: REFERENCE_PASSAGE_A, blockId: "para-9" }],
        },
      ],
    });
    expect(findingFingerprint(referencePayload(), "deviation")).not.toBe(
      findingFingerprint(moved, "deviation"),
    );
  });

  // The evidence is the pinned passage's identity, not the block id it was
  // last cited under: a re-run quoting the same passage from a renumbered
  // block must not reopen the decision.
  test("changes when the standard's own passage changes", () => {
    const other = referencePayload({
      referenceCitations: [
        {
          fileFieldId: REFERENCE_FIELD_A,
          passages: [{ id: REFERENCE_PASSAGE_B, blockId: "para-9" }],
        },
      ],
    });
    expect(findingFingerprint(referencePayload(), "deviation")).not.toBe(
      findingFingerprint(other, "deviation"),
    );
  });

  test("treats a null extracted value as different from an empty one", () => {
    expect(
      findingFingerprint(playbookPayload({ extracted: null }), "compliant"),
    ).not.toBe(
      findingFingerprint(
        playbookPayload({ extracted: { value: "", text: "" } }),
        "compliant",
      ),
    );
  });

  // Re-extraction can rewrap a quoted passage without changing what it quotes.
  test("normalizes whitespace inside an excerpt", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,12}$/u),
        fc.stringMatching(/^[a-z]{1,12}$/u),
        fc.stringMatching(/^[ \t\n\r]{1,4}$/u),
        (left, right, whitespace) => {
          const tight = playbookPayload({
            citations: [{ blockId: "para-7", text: `${left} ${right}` }],
          });
          const loose = playbookPayload({
            citations: [
              {
                blockId: "para-7",
                text: `${whitespace}${left}${whitespace}${right}${whitespace}`,
              },
            ],
          });
          expect(findingFingerprint(tight, "compliant")).toBe(
            findingFingerprint(loose, "compliant"),
          );
        },
      ),
      propertyConfig(),
    );
  });

  // Distinct evidence must not collide onto one fingerprint, or a decision
  // would carry onto a finding about different text.
  test("distinguishes any two different excerpts", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z ]{1,24}$/u),
        fc.stringMatching(/^[a-z ]{1,24}$/u),
        (left, right) => {
          const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
          fc.pre(normalize(left) !== normalize(right));
          expect(
            findingFingerprint(
              playbookPayload({
                citations: [{ blockId: "para-7", text: left }],
              }),
              "compliant",
            ),
          ).not.toBe(
            findingFingerprint(
              playbookPayload({
                citations: [{ blockId: "para-7", text: right }],
              }),
              "compliant",
            ),
          );
        },
      ),
      propertyConfig(),
    );
  });
});
