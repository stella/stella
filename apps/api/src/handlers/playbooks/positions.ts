import { t } from "elysia";
import type { Static } from "elysia";

import { propertyContentSchema } from "@/api/db/schema-validators";
import {
  positionRuleSchema,
  positionSeveritySchema,
  positionStandardSchema,
  resolvedStandardSchema,
} from "@/api/handlers/playbooks/position-facets";
import { tConditionNode } from "@/api/lib/conditions/contract";

// The EXPECT/GRADE/severity facets and the run-time `ResolvedStandard` snapshot
// live in `position-facets.ts`, a leaf module with no `db/schema-validators`
// dependency, so the `playbook-verdict` property tool (defined in
// schema-validators) can embed them without an import cycle. The grading engine
// and the v2 → engine shim (`position-adapter.ts`) consume these too, so
// re-export them from this one module. They are unchanged in slice A: the shim
// keeps grading on the v1 vocabulary while the engine stays untouched.
export {
  positionRuleSchema,
  positionSeveritySchema,
  positionStandardSchema,
  resolvedStandardSchema,
};
export type PositionRule = Static<typeof positionRuleSchema>;
export type PositionSeverity = Static<typeof positionSeveritySchema>;
export type PositionStandard = Static<typeof positionStandardSchema>;
export type ResolvedStandard = Static<typeof resolvedStandardSchema>;

const version2 = t.Literal(2);

// ── Tier lines: identified plain-language rules and fallback entries ──
// `id` is client-generated so reorder/DnD and finding citations reference a
// stable identity, not the array index. Rank stays implicit in array order.
export const tierRuleSchema = t.Object({
  id: t.String({ format: "uuid" }),
  text: t.String({ minLength: 1, maxLength: 500 }),
});
export type TierRule = Static<typeof tierRuleSchema>;

// A fallback entry is simultaneously a rule and language (the accepted
// alternative wording), so its text is capped like ideal language rather than
// like a one-line rule.
export const fallbackEntrySchema = t.Object({
  id: t.String({ format: "uuid" }),
  text: t.String({ minLength: 1, maxLength: 10_000 }),
  label: t.Optional(t.String({ maxLength: 256 })),
});
export type FallbackEntry = Static<typeof fallbackEntrySchema>;

// ── Ideal language: the acceptable tier's answer key ──
// A clause link (resolved at run time) or inline text. FIX inserts this text
// when a document deviates; the absence of ideal language is structural.
export const idealLanguageSchema = t.Union([
  t.Object({
    source: t.Literal("clause"),
    clauseId: t.String({ format: "uuid" }),
    // Pinned clause version; the latest is resolved at run time when absent.
    clauseVersion: t.Optional(t.Integer({ minimum: 1 })),
  }),
  t.Object({
    source: t.Literal("inline"),
    text: t.String({ maxLength: 10_000 }),
  }),
]);
export type IdealLanguage = Static<typeof idealLanguageSchema>;

// ── Tiers: the Acceptable / Fallback / Not acceptable ladder ──
export const tiersSchema = t.Object({
  acceptable: t.Object({
    rules: t.Array(tierRuleSchema, { maxItems: 50 }),
    ideal: t.Optional(idealLanguageSchema),
  }),
  fallback: t.Object({
    // Ranked by array order.
    entries: t.Array(fallbackEntrySchema, { maxItems: 10 }),
  }),
  notAcceptable: t.Object({
    // Red lines.
    rules: t.Array(tierRuleSchema, { maxItems: 50 }),
  }),
});
export type Tiers = Static<typeof tiersSchema>;

// ── Deterministic check: an Advanced-only override ──
// When present, grading is deterministic (presence/condition, no LLM) and the
// tiers provide language/fix only. `presence`/`propertyConstraint` from v1
// survive here; `constraint` carries the shared @stll/conditions AST.
export const deterministicCheckSchema = t.Union([
  t.Object({
    kind: t.Literal("presence"),
    expectation: t.UnionEnum(["required", "restricted"]),
  }),
  t.Object({
    kind: t.Literal("constraint"),
    condition: tConditionNode,
  }),
]);
export type DeterministicCheck = Static<typeof deterministicCheckSchema>;

// ── ASK: what to read from each document ──────────────
// An empty `question` means manual input (no AI extraction), mirroring v1.
const askQuestionSchema = t.String({ maxLength: 1000 });

export const askManualSchema = t.Object({
  question: askQuestionSchema,
  content: propertyContentSchema,
});
export type AskManual = Static<typeof askManualSchema>;

// Extraction config for a graded position. `auto` derives the question/content
// from the issue + tier rules at save time (slice B); `derived` is that stored
// result and is consumed at run time exactly like a manual ask. `manual` is the
// Advanced escape hatch. `derived` lives only on the `auto` variant, so a manual
// ask structurally cannot carry one.
export const askConfigSchema = t.Union([
  t.Object({
    mode: t.Literal("auto"),
    derived: t.Optional(
      t.Object({
        question: askQuestionSchema,
        content: propertyContentSchema,
        rulesHash: t.String({ minLength: 1, maxLength: 128 }),
      }),
    ),
  }),
  t.Object({
    mode: t.Literal("manual"),
    question: askQuestionSchema,
    content: propertyContentSchema,
  }),
]);
export type AskConfig = Static<typeof askConfigSchema>;

// ── Position: a discriminated union on `mode` ─────────
// `sourceId` is a stable, client-supplied id that survives edits so re-running a
// playbook maps a position back to the same materialized column/finding instead
// of duplicating it. A disabled position is skipped by run, review, and auto-run.
const extractPositionSchema = t.Object({
  // Captures a value, no grading. Severity is meaningless here, so it is absent.
  mode: t.Literal("extract"),
  sourceId: t.String({ format: "uuid" }),
  issue: t.String({ minLength: 1, maxLength: 256 }),
  ask: askManualSchema,
  guidance: t.Optional(t.String({ maxLength: 2000 })),
  enabled: t.Boolean(),
});

const gradedPositionSchema = t.Object({
  mode: t.Literal("graded"),
  sourceId: t.String({ format: "uuid" }),
  issue: t.String({ minLength: 1, maxLength: 256 }),
  severity: positionSeveritySchema,
  tiers: tiersSchema,
  check: t.Optional(deterministicCheckSchema),
  ask: askConfigSchema,
  guidance: t.Optional(t.String({ maxLength: 2000 })),
  enabled: t.Boolean(),
});

export const positionSchema = t.Union([
  extractPositionSchema,
  gradedPositionSchema,
]);
export type Position = Static<typeof positionSchema>;

// ── Positions container (version-tagged JSONB) ────────
// Hard `t.Literal(2)`: no multi-version dispatch. Playbooks never shipped
// publicly, so v1 is migrated once and no runtime v1 read path survives.
export const playbookPositionsSchema = t.Object({
  version: version2,
  items: t.Array(positionSchema, { maxItems: 200 }),
});
export type PlaybookPositions = Static<typeof playbookPositionsSchema>;

// ── Scope: what the playbook targets ──────────────────
// Binds a playbook to a document TYPE (a stable slug from the org-owned
// document-type taxonomy) and a review PERSPECTIVE. When `documentTypeKey` is
// set, a files-table run gates each materialized column on the workspace's
// "Document Type" classifier so only matching documents are extracted/graded.
// Routing (`trigger`) is slice D; this schema is unchanged in slice A.
export const playbookScopeSchema = t.Object({
  documentTypeKey: t.Optional(t.String({ maxLength: 128 })),
  // t.Union([t.Literal(...)]) rather than t.Optional(t.UnionEnum(...)): an
  // absent optional UnionEnum coerces to its first member instead of undefined.
  perspective: t.Optional(
    t.Union([t.Literal("buyer"), t.Literal("seller"), t.Literal("neutral")]),
  ),
});
export type PlaybookScope = Static<typeof playbookScopeSchema>;
