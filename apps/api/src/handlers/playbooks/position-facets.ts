import { t } from "elysia";
import type { Static } from "elysia";

import { tConditionNode } from "@/api/lib/conditions/contract";

// Leaf module: the EXPECT/GRADE/severity facets of a Position, with no
// dependency on db/schema-validators. This lets both positions.ts (which also
// needs propertyContentSchema for ASK) and schema-validators.ts (which embeds
// the rule/severity in the playbook-verdict property tool) import these without
// an import cycle.

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

// ── EXPECT: the standard / answer key ─────────────────
// Discriminated on `source`. FIX (insert preferred language) is only meaningful
// for `clause` and `inline`; `none` can flag but has no language to insert, so
// the absence of language is structural, not a runtime flag.
const inlineFallbackSchema = t.Object({
  rank: t.Integer({ minimum: 0 }),
  label: t.Optional(t.String({ maxLength: 256 })),
  text: t.String({ minLength: 1, maxLength: 10_000 }),
});

export const positionStandardSchema = t.Union([
  t.Object({
    source: t.Literal("clause"),
    clauseId: t.String({ format: "uuid" }),
    // Pinned clause version; the latest is resolved at run time when absent.
    clauseVersion: t.Optional(t.Integer({ minimum: 1 })),
  }),
  t.Object({
    source: t.Literal("inline"),
    preferred: t.Optional(t.String({ maxLength: 10_000 })),
    fallbacks: t.Optional(t.Array(inlineFallbackSchema, { maxItems: 10 })),
  }),
  t.Object({
    source: t.Literal("none"),
  }),
]);
export type PositionStandard = Static<typeof positionStandardSchema>;

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

// ── Resolved standard (verdict-time snapshot) ─────────
// A clause-source standard is resolved to its preferred body + ranked fallback
// texts at run time and snapshotted onto the verdict tool, so grading does not
// re-read the (mutable, separately-versioned) clause library.
export const resolvedStandardSchema = t.Object({
  preferred: t.Optional(t.String({ maxLength: 10_000 })),
  fallbacks: t.Optional(
    t.Array(
      t.Object({
        rank: t.Integer({ minimum: 0 }),
        text: t.String({ minLength: 1, maxLength: 10_000 }),
      }),
      { maxItems: 10 },
    ),
  ),
});
export type ResolvedStandard = Static<typeof resolvedStandardSchema>;
