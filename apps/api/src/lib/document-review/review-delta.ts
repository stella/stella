/**
 * What differs between the document and the standard, typed by the shape of
 * the difference rather than described in prose.
 *
 * The delta is what the fix is derived from (`grounded-review-fix.ts`) and
 * what the finding renders as, so a number change cannot become a
 * whole-paragraph rewrite and a missing limb cannot become a replacement.
 */

import { panic } from "better-result";

import type {
  ReferenceImpact,
  ReviewPerspective,
} from "@/api/lib/document-review/contract";
import type { DocxFolioCitation } from "@/api/lib/document-review/review-extract";
import type { PositionTermKind } from "@/api/lib/workflow/playbook-position-facets";

/**
 * One side of a parameter difference. `text` is the term exactly as it reads
 * in the cited block (that is what makes a substring-grounded replacement
 * possible); `value` and `unit` are its parsed form, present only when the
 * term is a quantity the model could resolve.
 */
export type DeltaValue = {
  text: string;
  value: number | null;
  unit: string | null;
  citation: DocxFolioCitation;
};

/** One limb of an enumerated list, on either or both sides. */
export type DeltaEnumerationItem = {
  label: string;
  inTarget: boolean;
  inStandard: boolean;
  citation: DocxFolioCitation | null;
};

export type ReviewDelta =
  | {
      kind: "parameter";
      target: DeltaValue | null;
      standard: DeltaValue | null;
    }
  | { kind: "enumeration"; items: DeltaEnumerationItem[] }
  | { kind: "presence"; term: string; inTarget: boolean; inStandard: boolean }
  | { kind: "language" };

export type ReviewDeltaKind = ReviewDelta["kind"];

/**
 * The delta kind grading must answer a position with, by the position's term
 * kind. It is the identity, and that is the point: the two vocabularies are
 * one list, and this map is what makes it a compile-time fact rather than a
 * convention — it must cover every term kind, and every value must name a
 * delta branch. A position typed as a parameter therefore cannot come back as
 * a whole-clause rewrite; the only other answer grading may give is
 * {@link LANGUAGE_DELTA}, which claims nothing structural.
 */
export const EXPECTED_DELTA_KIND = {
  parameter: "parameter",
  enumeration: "enumeration",
  presence: "presence",
  language: "language",
} as const satisfies Record<PositionTermKind, ReviewDeltaKind>;

/** The difference is language until something says otherwise: prose is the
 *  weakest claim about a delta, and the one that needs no structure. */
export const LANGUAGE_DELTA: ReviewDelta = { kind: "language" };

/**
 * Which way a quantity moves for the side the run acts for. The model is never
 * asked "is this good for the buyer" — only which direction of the quantity
 * favours whoever the drafter acts for. The comparison itself is arithmetic.
 */
export const PARAMETER_DIRECTIONS = [
  "higher-favours-target-side",
  "lower-favours-target-side",
  "unknown",
] as const;
export type ParameterDirection = (typeof PARAMETER_DIRECTIONS)[number];

type DeriveParameterImpactArgs = {
  direction: ParameterDirection;
  delta: Extract<ReviewDelta, { kind: "parameter" }>;
  perspective: ReviewPerspective;
};

/**
 * The impact of a parameter delta, computed rather than asked.
 *
 * Unknown whenever the comparison is not decidable: no side was named, the
 * model could not say which direction favours that side, a side is missing a
 * number, or the two numbers are stated in different units (a 6-month cap and
 * a 6-year cap are both "6").
 */
export const deriveParameterImpact = ({
  direction,
  delta,
  perspective,
}: DeriveParameterImpactArgs): ReferenceImpact => {
  if (perspective.type === "neutral" || direction === "unknown") {
    return "unknown";
  }
  const targetValue = delta.target?.value ?? null;
  const standardValue = delta.standard?.value ?? null;
  if (targetValue === null || standardValue === null) {
    return "unknown";
  }
  const targetUnit = delta.target?.unit ?? null;
  const standardUnit = delta.standard?.unit ?? null;
  if (
    targetUnit !== null &&
    standardUnit !== null &&
    targetUnit !== standardUnit
  ) {
    return "unknown";
  }
  if (targetValue === standardValue) {
    return "neutral";
  }
  const targetIsHigher = targetValue > standardValue;
  switch (direction) {
    case "higher-favours-target-side":
      return targetIsHigher ? "favourable" : "unfavourable";
    case "lower-favours-target-side":
      return targetIsHigher ? "unfavourable" : "favourable";
    default:
      direction satisfies never;
      return panic(`Unhandled direction: ${String(direction)}`);
  }
};
