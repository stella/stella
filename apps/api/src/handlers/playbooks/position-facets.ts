import { t } from "elysia";
import type { Static } from "elysia";

import { tConditionNode } from "@/api/lib/conditions/contract";

// Leaf module: the run-time grading facets of a Position (the `rule`
// discriminator, `severity`, and the `ResolvedTiers` verdict-time snapshot),
// with no dependency on db/schema-validators. This lets both positions.ts (which
// also needs propertyContentSchema for ASK) and schema-validators.ts (which
// embeds the rule/severity/tiers in the playbook-verdict property tool) import
// these without an import cycle.

// ── Severity ──────────────────────────────────────────
// `blocker` is the walk-away / non-negotiable tier; the rest are the
// conventional 3-tier review scale.
export const positionSeveritySchema = t.UnionEnum([
  "blocker",
  "high",
  "medium",
  "low",
]);
export type PositionSeverity = Static<typeof positionSeveritySchema>;

// ── GRADE: how the extracted answer is judged ─────────
export const positionRuleSchema = t.Union([
  // No verdict: produces a value column only (today's extraction column).
  t.Object({ kind: t.Literal("extractOnly") }),
  // The clause must be present / absent.
  t.Object({
    kind: t.Literal("presence"),
    expectation: t.UnionEnum(["required", "restricted"]),
  }),
  // Deterministic check over the extracted value via the shared condition AST;
  // no LLM.
  t.Object({
    kind: t.Literal("propertyConstraint"),
    condition: tConditionNode,
  }),
  // The LLM compares the extracted prose to the standard's preferred/fallbacks
  // and returns a tier.
  t.Object({ kind: t.Literal("positionMatch") }),
]);
export type PositionRule = Static<typeof positionRuleSchema>;

// ── Resolved tiers (verdict-time snapshot) ────────────
// The tiered ladder resolved at run time and snapshotted onto the verdict tool,
// so grading is judged against exactly what the author saw even if the playbook
// definition (or a clause-sourced ideal) changes mid-run:
//   - `ideal`: the acceptable tier's resolved ideal language (inline text, or a
//     clause body at its pinned/latest version). FIX inserts this text.
//   - `fallbacks`: ranked accepted alternatives — explicit fallback entries
//     first (in authored order), then clause variants when the ideal is
//     clause-sourced. `rank` is the position in THIS array, so a grader's
//     `matched.rank` indexes it directly.
//   - `acceptableRules` / `notAcceptableRules`: the plain-language rules a
//     graded LLM tier-match compares against; red-line ids let a finding cite
//     which line was violated.
const resolvedTierRuleSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 128 }),
  text: t.String({ minLength: 1, maxLength: 500 }),
});

export const resolvedTiersSchema = t.Object({
  ideal: t.Optional(t.String({ maxLength: 10_000 })),
  fallbacks: t.Array(
    t.Object({
      rank: t.Integer({ minimum: 0 }),
      label: t.Optional(t.String({ maxLength: 256 })),
      text: t.String({ minLength: 1, maxLength: 10_000 }),
    }),
    { maxItems: 10 },
  ),
  acceptableRules: t.Array(resolvedTierRuleSchema, { maxItems: 50 }),
  notAcceptableRules: t.Array(resolvedTierRuleSchema, { maxItems: 50 }),
});
export type ResolvedTiers = Static<typeof resolvedTiersSchema>;
