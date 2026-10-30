import * as v from "valibot";

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
export const POSITION_SEVERITIES = [
  "blocker",
  "high",
  "medium",
  "low",
] as const;
export const positionSeveritySchema = v.picklist([...POSITION_SEVERITIES]);
export type PositionSeverity = v.InferOutput<typeof positionSeveritySchema>;

// ── Term kind: what shape of term the position is about ──
// A position is one reviewable term, and its kind decides how comparing it is
// expressed, shown and edited:
//   - `parameter`: one stated quantity (a period, a cap, a threshold, a rate).
//   - `enumeration`: a list-shaped definition or a set of heads.
//   - `presence`: a defined term or protection that either exists or does not.
//   - `language`: a standard of wording with no parameter behind it.
// This is the same closed vocabulary as `ReviewDeltaKind`, and deliberately so:
// grading a position may not answer it with a different kind of difference
// (`review-delta.ts` derives its list from this one).
export const POSITION_TERM_KINDS = [
  "parameter",
  "enumeration",
  "presence",
  "language",
] as const;
export const positionTermKindSchema = v.picklist([...POSITION_TERM_KINDS]);
export type PositionTermKind = v.InferOutput<typeof positionTermKindSchema>;

// ── GRADE: how the extracted answer is judged ─────────
export const positionRuleSchema = v.union([
  v.object({ kind: v.literal("extractOnly") }),
  v.object({
    kind: v.literal("presence"),
    expectation: v.picklist(["required", "restricted"]),
  }),
  v.object({
    kind: v.literal("propertyConstraint"),
    condition: tConditionNode,
  }),
  v.object({ kind: v.literal("positionMatch") }),
]);

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
const resolvedTierRuleSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

export const resolvedTiersSchema = v.object({
  ideal: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
  fallbacks: v.pipe(
    v.array(
      v.object({
        rank: v.pipe(v.number(), v.integer(), v.minValue(0)),
        label: v.optional(v.pipe(v.string(), v.maxLength(256))),
        text: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
      }),
    ),
    v.maxLength(10),
  ),
  acceptableRules: v.pipe(v.array(resolvedTierRuleSchema), v.maxLength(50)),
  notAcceptableRules: v.pipe(v.array(resolvedTierRuleSchema), v.maxLength(50)),
});
