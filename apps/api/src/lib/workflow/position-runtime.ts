import type { PropertyContent } from "@/api/db/schema-validators";
import type {
  Position,
  PositionRule,
  ReferencePassage,
  Tiers,
} from "@/api/lib/workflow/playbook-positions";

// Run-time projection of a v2 position, shared by the files-table materializer
// (`materialize-run.ts`) and the single-doc ephemeral review (`review.ts` /
// `review-grade.ts`) so the two surfaces cannot drift on how a position is
// extracted and graded. Replaces the slice-A `position-adapter.ts` shim: the
// engine now consumes v2 positions natively, so these helpers only derive the
// small run-time facts (effective ASK, grading rule, enabled filter) instead of
// projecting a whole v1-shaped position.

export type GradedPosition = Extract<Position, { mode: "graded" }>;

// A graded position whose standard is an authored tier ladder. Only these
// resolve to `ResolvedTiers`, derive an auto ASK from rules, or reach the
// clause loader; a reference-standard position grades against its passages.
export type TierStandardPosition = GradedPosition & {
  standard: { source: "tiers"; tiers: Tiers };
};

export const isTierStandard = (
  position: Position,
): position is TierStandardPosition =>
  position.mode === "graded" && position.standard.source === "tiers";

/** The authored ladder, or `null` for a position graded against a reference. */
export const positionTiers = (position: Position): Tiers | null =>
  isTierStandard(position) ? position.standard.tiers : null;

/** The reference passages a position is graded against, or `null` when its
 *  standard is an authored ladder. */
export const positionPassages = (
  position: Position,
): readonly ReferencePassage[] | null =>
  position.mode === "graded" && position.standard.source === "reference"
    ? position.standard.passages
    : null;

// Materialize/grade only enabled positions: a disabled position is skipped by
// run, review, and auto-run. Centralizing the filter keeps the call sites from
// drifting on the skip semantics.
export const selectEnabledPositions = (
  positions: readonly Position[],
): Position[] => positions.filter((position) => position.enabled);

// The flat `{ question, content }` a position is extracted with. Extract-only
// positions carry a manual ask; graded positions resolve their `AskConfig`:
// a manual ask, a stored `derived` auto ask (consumed exactly like a manual
// one), or — until derivation populates `derived` — a generic text ask over the
// issue so run/review never block on a missing derivation.
export type EffectiveAsk = { question: string; content: PropertyContent };

export const resolveEffectiveAsk = (position: Position): EffectiveAsk => {
  if (position.mode === "extract") {
    return { question: position.ask.question, content: position.ask.content };
  }
  const { ask } = position;
  if (ask.mode === "manual") {
    return { question: ask.question, content: ask.content };
  }
  if (ask.derived !== undefined) {
    return { question: ask.derived.question, content: ask.derived.content };
  }
  return { question: position.issue, content: { version: 1, type: "text" } };
};

// A graded position's grading rule for the materialized verdict tool. Without a
// deterministic `check`, grading is the default LLM tier-match (`positionMatch`,
// the persisted rule kind consumed by the verdict engine); a `presence` /
// `constraint` check maps to the deterministic rule kinds.
export const gradedPositionRule = (position: GradedPosition): PositionRule => {
  const { check } = position;
  if (check === undefined) {
    return { kind: "positionMatch" };
  }
  if (check.kind === "presence") {
    return { kind: "presence", expectation: check.expectation };
  }
  return { kind: "propertyConstraint", condition: check.condition };
};
