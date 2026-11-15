import { panic } from "better-result";

import type { PropertyContent } from "@/api/db/schema-validators";
import type { AnswerShape } from "@/api/lib/workflow/ai-answer-schema";
import type {
  Position,
  PositionRule,
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

// A tier-standard position's grading inputs, in stored order. Ideal language is
// excluded: it drives FIX, not what is extracted or how a clause is graded.
export const canonicalRulesInput = (position: TierStandardPosition) => {
  const { tiers } = position.standard;
  return {
    issue: position.issue,
    acceptableRuleTexts: tiers.acceptable.rules.map((rule) => rule.text),
    fallbackTexts: tiers.fallback.entries.map((entry) => entry.text),
    notAcceptableRuleTexts: tiers.notAcceptable.rules.map((rule) => rule.text),
    check: position.check ?? null,
  };
};

// Materialize/grade only enabled positions: a disabled position is skipped by
// run, review, and auto-run. Centralizing the filter keeps the call sites from
// drifting on the skip semantics.
export const selectEnabledPositions = (
  positions: readonly Position[],
): Position[] => positions.filter((position) => position.enabled);

// The flat `{ question, content }` a position is extracted with. Extract-only
// positions carry a manual ask; graded positions resolve their ask configuration:
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

// Only a tier match reads a clause. A presence check or a constraint reads the
// answer itself, so those answers stay the value they have always been.
export const answerShapeForRule = (rule: PositionRule): AnswerShape => {
  switch (rule.kind) {
    case "positionMatch":
      return "clause-summary";
    case "presence":
    case "propertyConstraint":
    case "extractOnly":
      return "value";
    default:
      rule satisfies never;
      return panic(`Unhandled rule: ${String(rule)}`);
  }
};

export const answerShapeForPosition = (position: Position): AnswerShape =>
  position.mode === "graded"
    ? answerShapeForRule(gradedPositionRule(position))
    : "value";
