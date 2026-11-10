// Claim qualifiers: caveats a verdict carries without changing it. A
// qualifier never moves a claim's state or score; it says what a reader of
// the verdict should know about it.
//
// The grader sets the ones only a reading of the claim can tell, and they
// are stored with its grade. The system computes the rest whenever the claim
// is read, from the facts its verdict rests on as they stand on the list now,
// so a fact that gains a source or is held updates every claim resting on it
// without a re-run.
//
// Dependency-light on purpose: the database schema derives its CHECK from
// these consts.

import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type { FactScoring } from "@/api/lib/lists/fact-details";
import { CLAIM_STATES } from "@/api/lib/lists/verification/contract";
import type {
  ClaimRef,
  ClaimState,
  ClaimVerdict,
} from "@/api/lib/lists/verification/contract";
import type { ClaimReview } from "@/api/lib/lists/verification/review-fold";

/** Set by the grader and stored with the grade. */
export const GRADER_CLAIM_QUALIFIERS = [
  "record-silent",
  "scope-mismatch",
] as const;
export type GraderClaimQualifierKind = (typeof GRADER_CLAIM_QUALIFIERS)[number];

/** Computed at read time; never stored. */
const SYSTEM_CLAIM_QUALIFIERS = ["unsourced-only", "rests-on-held"] as const;
type SystemClaimQualifierKind = (typeof SYSTEM_CLAIM_QUALIFIERS)[number];

export const CLAIM_QUALIFIERS = [
  ...GRADER_CLAIM_QUALIFIERS,
  ...SYSTEM_CLAIM_QUALIFIERS,
] as const;

type ClaimQualifierKind = (typeof CLAIM_QUALIFIERS)[number];

/** Whether a claim carrying the qualifier may be accepted with the routine
 *  claims, or needs a reviewer's own decision. */
export const QUALIFIER_REVIEWS = ["routine", "needs-judgement"] as const;
type QualifierReview = (typeof QUALIFIER_REVIEWS)[number];

/**
 * The review each qualifier asks for, total so a new qualifier cannot slip
 * into the routine claims unnoticed. A silent record and unsourced facts are
 * disclosed, not doubted: knowledge without a source is allowed, so the
 * verdict stays routine and its copy names the caveat. A cited fact of a
 * different scope, or one now held out of scoring, leaves the verdict on
 * footing a person has to weigh.
 */
export const QUALIFIER_REVIEW = {
  "record-silent": "routine",
  "scope-mismatch": "needs-judgement",
  "unsourced-only": "routine",
  "rests-on-held": "needs-judgement",
} as const satisfies Record<ClaimQualifierKind, QualifierReview>;

export const qualifiersNeedJudgement = (
  qualifiers: readonly Pick<ClaimQualifier, "review">[],
): boolean => qualifiers.some(({ review }) => review === "needs-judgement");

export const CLAIM_QUALIFIER_EXPLANATION_MAX = 500;

/** A grader qualifier carries the grader's one-line reason for it. */
export type GraderClaimQualifier = {
  kind: GraderClaimQualifierKind;
  explanation: string;
};

/** A system qualifier's reason is its rule, so it carries none of its own. */
/** A qualifier as a claim is read: what it is, why, and the review it asks
 *  for, so every reader triages from this one rule. */
export type ClaimQualifier = (
  GraderClaimQualifier | { kind: SystemClaimQualifierKind; explanation: null }
) & { review: QualifierReview };

/**
 * The verdicts each grader qualifier may accompany. A record that is not
 * expected to speak to a point only explains missing coverage; a fact about
 * a different scope can sit beside any verdict.
 */
const GRADER_QUALIFIER_STATES = {
  "record-silent": ["nocover"],
  "scope-mismatch": CLAIM_STATES,
} as const satisfies Record<GraderClaimQualifierKind, readonly ClaimState[]>;

export const graderQualifierFits = (
  kind: GraderClaimQualifierKind,
  state: ClaimState,
): boolean => {
  const states: readonly ClaimState[] = GRADER_QUALIFIER_STATES[kind];
  return states.includes(state);
};

/** Whether a fact currently has a source that has not been rejected. */
type FactSourcing = "sourced" | "unsourced";

/** What the system qualifiers read of one fact, as it stands now. */
export type FactStanding = {
  scoring: FactScoring;
  sourcing: FactSourcing;
};

/** Each system qualifier's rule over the facts a verdict rests on. A new
 *  system qualifier cannot be added without its rule. */
const SYSTEM_QUALIFIER_RULES = {
  // Held facts never score, so a verdict resting on one no longer has the
  // footing it was given.
  "rests-on-held": (facts) => facts.some((fact) => fact.scoring === "held"),
  "unsourced-only": (facts) =>
    facts.length > 0 && facts.every((fact) => fact.sourcing === "unsourced"),
} as const satisfies Record<
  SystemClaimQualifierKind,
  (facts: readonly FactStanding[]) => boolean
>;

type RestingTarget = {
  verdict: ClaimVerdict;
  refs: readonly ClaimRef[];
};

/**
 * The facts the verdict a reviewer sees rests on: the facts a scored verdict
 * cites, or the record a reviewer chose to govern a record conflict. Missing
 * coverage, a set-aside claim and an unresolved conflict rest on none. An
 * override is an annotation beside the verdict and does not change this.
 */
export const restingFactIds = (
  { verdict, refs }: RestingTarget,
  review: ClaimReview | null,
): SafeId<"entity">[] => {
  switch (verdict.state) {
    case "supported":
    case "tension":
    case "contradicted": {
      return refs.map((ref) => ref.factEntityId);
    }
    case "nocover":
    case "notverifiable": {
      return [];
    }
    case "recordconflict": {
      const resolution = review?.recordConflictResolution ?? null;
      return resolution?.kind === "governed" ? [resolution.factEntityId] : [];
    }
    default: {
      verdict satisfies never;
      return panic(`Unhandled claim verdict: ${String(verdict)}`);
    }
  }
};

type ClaimQualifiersArgs = {
  graded: readonly GraderClaimQualifier[];
  /** The standing of each fact `restingFactIds` names. */
  resting: readonly FactStanding[];
};

/** Every qualifier of a claim: the grader's, then the system's, each in its
 *  declared order. */
export const claimQualifiers = ({
  graded,
  resting,
}: ClaimQualifiersArgs): ClaimQualifier[] => [
  ...GRADER_CLAIM_QUALIFIERS.flatMap((kind) =>
    graded
      .filter((qualifier) => qualifier.kind === kind)
      .map(({ explanation }) => ({
        kind,
        explanation,
        review: QUALIFIER_REVIEW[kind],
      })),
  ),
  ...SYSTEM_CLAIM_QUALIFIERS.filter((kind) =>
    SYSTEM_QUALIFIER_RULES[kind](resting),
  ).map((kind) => ({
    kind,
    explanation: null,
    review: QUALIFIER_REVIEW[kind],
  })),
];
