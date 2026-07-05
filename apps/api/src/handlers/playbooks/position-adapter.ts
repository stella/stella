import type { PropertyContent } from "@/api/db/schema-validators";
import type {
  Position,
  PositionRule,
  PositionSeverity,
  PositionStandard,
  Tiers,
} from "@/api/handlers/playbooks/positions";

// ─────────────────────────────────────────────────────────────────────────────
// SLICE A SHIM (temporary — remove in slice B).
//
// The grading engine (`lib/workflow/verdict-engine.ts`), the `ResolvedStandard`
// snapshot (`position-facets.ts`), and the `playbook-verdict` property tool
// (`db/schema-validators.ts`) still speak the v1 position vocabulary:
// `standard` (clause/inline/none) + `rule` (extractOnly/presence/
// propertyConstraint/positionMatch) + `severity` + a flat `{ question, content }`
// ask. This adapter projects a v2 tiered position onto those inputs so run-time
// grading behaviour is IDENTICAL to v1 while the engine stays untouched.
//
// Slice B rewrites the engine to consume tiers directly (`gradeTierMatch`,
// `ResolvedTiers`) and deletes this module. The tier *rule* texts
// (acceptable/notAcceptable plain-language lines) are intentionally NOT consumed
// here — the v1 engine has no place for them, so they exist in the schema but do
// not affect grading until slice B.
// ─────────────────────────────────────────────────────────────────────────────

// The v1-shaped position the engine + materializer consume.
export type EnginePosition = {
  sourceId: string;
  issue: string;
  ask: { question: string; content: PropertyContent };
  standard: PositionStandard;
  rule: PositionRule;
  severity: PositionSeverity;
  guidance: string | undefined;
};

// A graded position with no `check` grades by LLM tier-match (v1 positionMatch,
// the default for every graded position). A `presence`/`constraint` check maps
// back to the deterministic v1 rule kinds.
const toEngineRule = (check: GradedPosition["check"]): PositionRule => {
  if (check === undefined) {
    return { kind: "positionMatch" };
  }
  if (check.kind === "presence") {
    return { kind: "presence", expectation: check.expectation };
  }
  return { kind: "propertyConstraint", condition: check.condition };
};

// Tiers → v1 `standard`. Ideal clause language maps to a clause standard; ideal
// inline text + ranked fallback entries map to an inline standard's
// preferred/fallbacks. A clause ideal drops any sibling fallback entries because
// the v1 clause path resolves fallbacks from clause variants, not inline text —
// a combination v1 could not express, produced only by hand-authored v2 (never
// by the migration), and restored to full fidelity in slice B.
const toEngineStandard = (tiers: Tiers): PositionStandard => {
  const ideal = tiers.acceptable.ideal;
  if (ideal?.source === "clause") {
    return {
      source: "clause",
      clauseId: ideal.clauseId,
      ...(ideal.clauseVersion === undefined
        ? {}
        : { clauseVersion: ideal.clauseVersion }),
    };
  }

  const fallbacks = tiers.fallback.entries.map((entry, index) => ({
    rank: index,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    text: entry.text,
  }));
  const preferred = ideal?.source === "inline" ? ideal.text : undefined;

  if (preferred === undefined && fallbacks.length === 0) {
    return { source: "none" };
  }
  return {
    source: "inline",
    ...(preferred === undefined ? {} : { preferred }),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
};

// AskConfig → the flat `{ question, content }` the engine extracts with. A
// stored `derived` ask is consumed exactly like a manual one. Until slice B
// populates `derived`, an `auto` ask with none falls back to a generic text ask
// over the issue so grading never blocks on a missing derivation.
const toEngineAsk = (
  position: Position,
): { question: string; content: PropertyContent } => {
  // Extract-only positions carry a flat manual ask.
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

type GradedPosition = Extract<Position, { mode: "graded" }>;

export const toEnginePosition = (position: Position): EnginePosition => {
  if (position.mode === "extract") {
    return {
      sourceId: position.sourceId,
      issue: position.issue,
      ask: toEngineAsk(position),
      // Extract-only: a value column with no verdict. Severity is absent on the
      // v2 extract variant, so use a neutral placeholder the engine never reads
      // (materialize-run emits no verdict tool for extractOnly).
      standard: { source: "none" },
      rule: { kind: "extractOnly" },
      severity: "medium",
      guidance: position.guidance,
    };
  }

  return {
    sourceId: position.sourceId,
    issue: position.issue,
    ask: toEngineAsk(position),
    standard: toEngineStandard(position.tiers),
    rule: toEngineRule(position.check),
    severity: position.severity,
    guidance: position.guidance,
  };
};

// Materialize/grade only enabled positions: a disabled position is skipped by
// run, review, and auto-run. Centralizing the filter+project keeps the two call
// sites (materialize-run and the ephemeral review) from drifting.
export const selectEnginePositions = (
  positions: readonly Position[],
): EnginePosition[] =>
  positions.filter((position) => position.enabled).map(toEnginePosition);
