import * as v from "valibot";

import { propertyContentSchema } from "@/api/db/schema-validators";
import { tConditionNode } from "@/api/lib/conditions/contract";
import type { ConstantMap } from "@/api/lib/constant-map";
import {
  POSITION_SEVERITIES,
  POSITION_TERM_KINDS,
  type positionRuleSchema,
  positionSeveritySchema,
  positionTermKindSchema,
  type resolvedTiersSchema,
} from "@/api/lib/workflow/playbook-position-facets";

// The run-time grading facets (`rule` discriminator, `severity`) and the
// verdict-time `ResolvedTiers` snapshot live in `playbook-position-facets.ts`, a leaf
// module with no `db/schema-validators` dependency, so the `playbook-verdict`
// property tool (defined in schema-validators) can embed them without an import
// cycle. This module uses the leaf schemas to derive its position types.
export { POSITION_SEVERITIES, POSITION_TERM_KINDS };
export type PositionRule = v.InferOutput<typeof positionRuleSchema>;
export type PositionSeverity = v.InferOutput<typeof positionSeveritySchema>;
export type PositionTermKind = v.InferOutput<typeof positionTermKindSchema>;
export type ResolvedTiers = v.InferOutput<typeof resolvedTiersSchema>;

const version3 = v.literal(3);

// Named so the snake_case `save_playbook` input (`mcp/playbook-position-input.ts`)
// advertises the bounds this schema enforces instead of a copy of them.
export const POSITION_LIMITS = {
  issueMaxLength: 256,
  tierRuleTextMaxLength: 500,
  tierRulesMaxItems: 50,
  fallbackEntriesMaxItems: 10,
  fallbackLabelMaxLength: 256,
  languageTextMaxLength: 10_000,
  askQuestionMaxLength: 1000,
  guidanceMaxLength: 2000,
  rationaleMaxLength: 2000,
  talkingPointMaxLength: 500,
  talkingPointsMaxItems: 20,
  escalationMaxLength: 500,
  positionsMaxItems: 200,
  sourcesMaxItems: 20,
} as const;

// ── Tier lines: identified plain-language rules and fallback entries ──
// `id` is client-generated so reorder/DnD and finding citations reference a
// stable identity, not the array index. Rank stays implicit in array order.
const tierRuleSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(POSITION_LIMITS.tierRuleTextMaxLength),
  ),
});
export type TierRule = v.InferOutput<typeof tierRuleSchema>;

// A fallback entry is simultaneously a rule and language (the accepted
// alternative wording), so its text is capped like ideal language rather than
// like a one-line rule.
const fallbackEntrySchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(POSITION_LIMITS.languageTextMaxLength),
  ),
  label: v.optional(
    v.pipe(v.string(), v.maxLength(POSITION_LIMITS.fallbackLabelMaxLength)),
  ),
});
export type FallbackEntry = v.InferOutput<typeof fallbackEntrySchema>;

// ── Ideal language: the acceptable tier's answer key ──
// A clause link (resolved at run time) or inline text. FIX inserts this text
// when a document deviates; the absence of ideal language is structural.
const idealLanguageSchema = v.union([
  v.object({
    source: v.literal("clause"),
    clauseId: v.pipe(v.string(), v.uuid()),
    clauseVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  }),
  v.object({
    source: v.literal("inline"),
    text: v.pipe(
      v.string(),
      v.maxLength(POSITION_LIMITS.languageTextMaxLength),
    ),
  }),
]);
export type IdealLanguage = v.InferOutput<typeof idealLanguageSchema>;

// ── Tiers: the Acceptable / Fallback / Not acceptable ladder ──
const tiersSchema = v.object({
  acceptable: v.object({
    rules: v.pipe(
      v.array(tierRuleSchema),
      v.maxLength(POSITION_LIMITS.tierRulesMaxItems),
    ),
    ideal: v.optional(idealLanguageSchema),
  }),
  fallback: v.object({
    entries: v.pipe(
      v.array(fallbackEntrySchema),
      v.maxLength(POSITION_LIMITS.fallbackEntriesMaxItems),
    ),
  }),
  notAcceptable: v.object({
    rules: v.pipe(
      v.array(tierRuleSchema),
      v.maxLength(POSITION_LIMITS.tierRulesMaxItems),
    ),
  }),
});
export type Tiers = v.InferOutput<typeof tiersSchema>;

// ── Reference passage: one quoted block of a reference document ──
// Provenance only. The words live in `document_review_reference_passages`,
// one row per (version, block), owned by the matter the reference belongs to
// and read under that matter's row security; `id` names that row. A position
// therefore never carries another matter's text into the playbook or run that
// holds it, and a reader sees the quote exactly when they can open its source.
const referencePassageSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  workspaceId: v.pipe(v.string(), v.uuid()),
  entityId: v.pipe(v.string(), v.uuid()),
  fileFieldId: v.pipe(v.string(), v.uuid()),
  entityVersionId: v.pipe(v.string(), v.uuid()),
  blockId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});
export type ReferencePassage = v.InferOutput<typeof referencePassageSchema>;

// ── Standard: what "how it should be" is, for one graded position ──
// `tiers` is authored (an editor, a starter pack); `reference` is derived from
// a document someone already negotiated. Grading dispatches on `source`, so a
// position from either origin produces the same finding.
const positionStandardSchema = v.union([
  v.object({ source: v.literal("tiers"), tiers: tiersSchema }),
  v.object({
    source: v.literal("reference"),
    termKind: positionTermKindSchema,
    passages: v.pipe(
      v.array(referencePassageSchema),
      v.minLength(1),
      v.maxLength(12),
    ),
  }),
]);
export type PositionStandard = v.InferOutput<typeof positionStandardSchema>;
export type PositionStandardSource = PositionStandard["source"];

// ── Deterministic check: an Advanced-only override ──
// When present, grading is deterministic (presence/condition, no LLM) and the
// tiers provide language/fix only. `presence`/`propertyConstraint` from v1
// survive here; `constraint` carries the shared @stll/conditions AST.
export const deterministicCheckSchema = v.union([
  v.object({
    kind: v.literal("presence"),
    expectation: v.picklist(["required", "restricted"]),
  }),
  v.object({ kind: v.literal("constraint"), condition: tConditionNode }),
]);
export type DeterministicCheck = v.InferOutput<typeof deterministicCheckSchema>;

// ── ASK: what to read from each document ──────────────
// An empty `question` means manual input (no AI extraction), mirroring v1.
const askQuestionSchema = v.pipe(
  v.string(),
  v.maxLength(POSITION_LIMITS.askQuestionMaxLength),
);

const askManualSchema = v.object({
  question: askQuestionSchema,
  content: propertyContentSchema,
});
export type AskManual = v.InferOutput<typeof askManualSchema>;

// Extraction config for a graded position. `auto` derives the question/content
// from the issue + tier rules at save time (slice B); `derived` is that stored
// result and is consumed at run time exactly like a manual ask. `manual` is the
// Advanced escape hatch. `derived` lives only on the `auto` variant, so a manual
// ask structurally cannot carry one.
const askConfigSchema = v.union([
  v.object({
    mode: v.literal("auto"),
    derived: v.optional(
      v.object({
        question: askQuestionSchema,
        content: propertyContentSchema,
        rulesHash: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      }),
    ),
  }),
  v.object({
    mode: v.literal("manual"),
    question: askQuestionSchema,
    content: propertyContentSchema,
  }),
]);

// ── Source: one document a position was taken or revised from ──
// Stores ids only, and only to record where the position came from. A
// playbook is visible to the whole organization and its text is used in
// reviews of other matters, so the document's name and the matter's name are
// never stored. Each reader looks the ids up with their own access and sees
// a source only if they can open it. The matter id is stored with the
// document id (as in `referencePassageSchema`) because every consumer needs
// the matter to locate the document. Extra properties are rejected, so no
// writer can store a name next to the ids.
const positionSourceSchema = v.strictObject({
  workspaceId: v.pipe(v.string(), v.uuid()),
  entityId: v.pipe(v.string(), v.uuid()),
});
export type PositionSource = v.InferOutput<typeof positionSourceSchema>;

// A position with no sources omits the field; an empty list is never stored.
const positionSourcesSchema = v.optional(
  v.pipe(
    v.array(positionSourceSchema),
    v.minLength(1),
    v.maxLength(POSITION_LIMITS.sourcesMaxItems),
  ),
);

// ── Position: a discriminated union on `mode` ─────────
// `sourceId` is a stable, client-supplied id that survives edits so re-running a
// playbook maps a position back to the same materialized column/finding instead
// of duplicating it. A disabled position is skipped by run, review, and auto-run.
const extractPositionSchema = v.object({
  mode: v.literal("extract"),
  sourceId: v.pipe(v.string(), v.uuid()),
  issue: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(POSITION_LIMITS.issueMaxLength),
  ),
  ask: askManualSchema,
  guidance: v.optional(
    v.pipe(v.string(), v.maxLength(POSITION_LIMITS.guidanceMaxLength)),
  ),
  sources: positionSourcesSchema,
  enabled: v.boolean(),
});

// ── Negotiation: reviewer-facing guidance for a deviation/fallback verdict ──
// Authored alongside the tier ladder so a reviewer who sees a flagged clause
// knows what to say, not just that it is off-standard. Graded positions only:
// an extract position never grades, so it never surfaces a verdict to
// negotiate against.
const negotiationSchema = v.object({
  rationale: v.optional(
    v.pipe(v.string(), v.maxLength(POSITION_LIMITS.rationaleMaxLength)),
  ),
  talkingPoints: v.optional(
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(POSITION_LIMITS.talkingPointMaxLength),
        ),
      ),
      v.maxLength(POSITION_LIMITS.talkingPointsMaxItems),
    ),
  ),
  escalation: v.optional(
    v.pipe(v.string(), v.maxLength(POSITION_LIMITS.escalationMaxLength)),
  ),
});
export type Negotiation = v.InferOutput<typeof negotiationSchema>;

// ── Purpose: what the term is FOR ─────────────────────
// One sentence on the legal and economic function the term performs in this
// kind of deal, written from the side the review takes ("Caps the seller's
// exposure for warranty claims; drives the buyer's recovery ceiling").
//
// `guidance` says what a later comparison examines; `purpose` says why anyone
// negotiates the term at all. A reviewer confirming a proposed checklist reads
// a short quotation out of a document they may not have written, so without
// this they are asked to approve a term whose function is never stated.
//
// Optional and independent of `standard.source`: a reference-derived position
// gets one from the proposal pass, and a playbook author can write one for a
// tiers-standard position by hand. Reviewer-facing only — grading never reads
// it.
export const POSITION_PURPOSE_MAX_LENGTH = 240;

const gradedPositionSchema = v.object({
  mode: v.literal("graded"),
  sourceId: v.pipe(v.string(), v.uuid()),
  issue: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(POSITION_LIMITS.issueMaxLength),
  ),
  severity: positionSeveritySchema,
  standard: positionStandardSchema,
  check: v.optional(deterministicCheckSchema),
  ask: askConfigSchema,
  purpose: v.optional(
    v.pipe(v.string(), v.maxLength(POSITION_PURPOSE_MAX_LENGTH)),
  ),
  guidance: v.optional(
    v.pipe(v.string(), v.maxLength(POSITION_LIMITS.guidanceMaxLength)),
  ),
  negotiation: v.optional(negotiationSchema),
  sources: positionSourcesSchema,
  enabled: v.boolean(),
});

export const positionSchema = v.union([
  extractPositionSchema,
  gradedPositionSchema,
]);
export type Position = v.InferOutput<typeof positionSchema>;

// ── Positions container (version-tagged JSONB) ────────
// Hard `v.literal(3)`: no multi-version dispatch. Each version is lifted once
// by a migration and no runtime read path for an older one survives.
export const playbookPositionsSchema = v.object({
  version: version3,
  items: v.pipe(
    v.array(positionSchema),
    v.maxLength(POSITION_LIMITS.positionsMaxItems),
  ),
});
export type PlaybookPositions = v.InferOutput<typeof playbookPositionsSchema>;

// ── Scope: what the playbook targets ──────────────────
// Binds a playbook to a document TYPE (a stable slug from the org-owned
// document-type taxonomy) and a review PERSPECTIVE. When `documentTypeKey` is
// set, a files-table run gates each materialized column on the workspace's
// "Document Type" classifier so only matching documents are extracted/graded.
export const playbookScopeSchema = v.object({
  documentTypeKey: v.optional(v.pipe(v.string(), v.maxLength(128))),
  perspective: v.optional(v.picklist(["buyer", "seller", "neutral"])),
  trigger: v.optional(v.picklist(["manual", "onClassified"])),
});
export type PlaybookScope = v.InferOutput<typeof playbookScopeSchema>;
export type PlaybookTrigger = NonNullable<PlaybookScope["trigger"]>;

// ── Definition-level status (v1 approvals, advisory only) ─────────
// Editing a playbook (`update-by-id.ts`) always reverts it to `draft`.
// Approving (`approve.ts`) snapshots the current name/description/scope/
// positions into an immutable `playbook_definition_versions` row and flips
// this to `approved`. This status is advisory: nothing in the run/review
// path hard-blocks on it.
const playbookDefinitionStatusSchema = v.picklist(["draft", "approved"]);
export type PlaybookDefinitionStatus = v.InferOutput<
  typeof playbookDefinitionStatusSchema
>;

// ── Version provenance ────────────────────────────────────────────
// Why a `playbook_definition_versions` row exists. Today approval is the only
// reason one is written, and a run pins "the playbook's latest approved
// version" by reading the newest row — which is only the same thing while that
// stays true. The column says which it is instead of leaving the reader to
// assume, so a future snapshot taken for another reason (an import, a restore,
// an autosave) has to name itself and cannot be mistaken for an approval.
// Deliberately no default: a writer must decide.
export const PLAYBOOK_VERSION_SOURCES = ["approval"] as const;
export type PlaybookVersionSource = (typeof PLAYBOOK_VERSION_SOURCES)[number];
export const PLAYBOOK_VERSION_SOURCE = {
  APPROVAL: "approval",
} as const satisfies ConstantMap<PlaybookVersionSource>;
