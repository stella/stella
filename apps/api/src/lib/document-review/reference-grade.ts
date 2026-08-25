/**
 * Grading a position whose standard is a reference document.
 *
 * The comparison is per position, not per run: the position carries the
 * passages it was derived from, so the call sends the target document once and
 * the pinned passages inline. A playbook saved out of such a run therefore
 * grades the next deal without reading the original reference again.
 *
 * The model classifies and locates; it never chooses the edit. It returns an
 * assessment (mapped to the one verdict vocabulary), a typed delta, and, for a
 * quantity, only which direction of that quantity favours the side the drafter
 * acts for — the impact itself is arithmetic (`deriveParameterImpact`).
 */

import { Result } from "better-result";
import * as v from "valibot";

import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  perspectivePartyPhrase,
  REFERENCE_CONSENSUS_VALUES,
  REFERENCE_IMPACTS,
} from "@/api/lib/document-review/contract";
import type {
  ReferenceConsensus,
  ReferenceImpact,
  ReviewPerspective,
} from "@/api/lib/document-review/contract";
import {
  deriveParameterImpact,
  LANGUAGE_DELTA,
  PARAMETER_DIRECTIONS,
  REVIEW_DELTA_KINDS,
} from "@/api/lib/document-review/review-delta";
import type {
  DeltaEnumerationItem,
  DeltaValue,
  ReviewDelta,
} from "@/api/lib/document-review/review-delta";
import {
  buildReviewDocumentParts,
  reviewDocumentsScopeKey,
} from "@/api/lib/document-review/review-document-messages";
import type { DocxFolioCitation } from "@/api/lib/document-review/review-extract";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { buildGroundedReviewFix } from "@/api/lib/grounded-review-fix";
import type { GroundedReviewFix } from "@/api/lib/grounded-review-fix";
import { brandPersistedFieldId } from "@/api/lib/safe-id-boundaries";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import type { ReferencePassage } from "@/api/lib/workflow/playbook-positions";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

const REFERENCE_GRADE_TIMEOUT_MS = 120_000;
const REFERENCE_GRADE_ROLE = "pdf" as const;
const MAX_VERIFIED_CITATIONS_PER_FINDING = 8;
/** Positions per model call. The target document dominates the prompt and is
 *  cached, so several positions per call amortise it without letting one
 *  failure take the whole run's grading with it. */
export const REFERENCE_GRADE_BATCH_SIZE = 8;

/**
 * How the target document handles a position, relative to the standard. The
 * model's own vocabulary; it never reaches the database, which stores the
 * verdict this maps to.
 */
export const REFERENCE_ASSESSMENTS = [
  "aligned",
  "different",
  "missing-from-target",
  "additional-in-target",
  "deal-specific",
  "not-comparable",
] as const;
export type ReferenceAssessment = (typeof REFERENCE_ASSESSMENTS)[number];

/**
 * One judgment vocabulary for every finding. A reference comparison and a tier
 * match answer the same question, so the comparison's answer is expressed as a
 * verdict here rather than persisted as a second vocabulary.
 */
export const ASSESSMENT_VERDICTS = {
  aligned: "compliant",
  different: "deviation",
  "missing-from-target": "missing",
  "additional-in-target": "additional",
  "deal-specific": "not-applicable",
  "not-comparable": "not-applicable",
} as const satisfies Record<ReferenceAssessment, VerdictTier>;

// ── Model output ──────────────────────────────────────
// Flat rather than a discriminated union: the schema is handed to the provider
// as JSON Schema, and a variant is the shape providers honour least reliably.
// `normalizeDelta` narrows it into the typed `ReviewDelta`.

const rawDeltaValueSchema = v.strictObject({
  /** The term exactly as the block states it, so a fix can locate it. */
  text: v.string(),
  value: v.nullable(v.number()),
  unit: v.nullable(v.string()),
  blockId: v.string(),
});

const rawDeltaSchema = v.strictObject({
  kind: v.picklist(REVIEW_DELTA_KINDS),
  targetValue: v.nullable(rawDeltaValueSchema),
  standardValue: v.nullable(rawDeltaValueSchema),
  items: v.array(
    v.strictObject({
      label: v.string(),
      inTarget: v.boolean(),
      inStandard: v.boolean(),
      blockId: v.nullable(v.string()),
    }),
  ),
  term: v.string(),
  inTarget: v.boolean(),
  inStandard: v.boolean(),
});

const rawFindingSchema = v.strictObject({
  positionId: v.string(),
  assessment: v.picklist(REFERENCE_ASSESSMENTS),
  consensus: v.picklist(REFERENCE_CONSENSUS_VALUES),
  rationale: v.string(),
  /** One instruction for the drafter; empty when nothing should change. */
  recommendation: v.string(),
  impact: v.picklist(REFERENCE_IMPACTS),
  direction: v.picklist(PARAMETER_DIRECTIONS),
  delta: rawDeltaSchema,
  proposedText: v.nullable(v.string()),
  /** Model-owned array; cardinality is normalized below because providers do
   *  not reliably honour JSON Schema array limits. */
  targetCitations: v.array(v.strictObject({ blockId: v.string() })),
});

export const referenceGradeSchema = v.strictObject({
  findings: v.array(rawFindingSchema),
});

type RawFinding = v.InferOutput<typeof rawFindingSchema>;

// ── Result ────────────────────────────────────────────

/** Everything reference grading decides about one position. The caller folds
 *  it into the single `ReviewFinding` shape. */
export type ReferenceGrading = {
  verdict: VerdictTier;
  delta: ReviewDelta;
  consensus: ReferenceConsensus;
  impact: ReferenceImpact;
  explanation:
    | { type: "comparison"; text: string }
    | { type: "insufficient-evidence" };
  recommendation: string | null;
  citations: DocxFolioCitation[];
  referenceCitations: {
    fileFieldId: SafeId<"field">;
    citations: DocxFolioCitation[];
  }[];
  fix: GroundedReviewFix | null;
};

/** A graded position with a reference standard, as this module reads it. */
export type ReferenceStandardPosition = {
  sourceId: string;
  issue: string;
  guidance?: string | undefined;
  passages: readonly ReferencePassage[];
};

// ── Normalization ─────────────────────────────────────

type BlockLookup = ReadonlyMap<string, string>;

const citationFor = (
  blockId: string,
  blocks: BlockLookup,
): DocxFolioCitation | null => {
  const text = blocks.get(blockId);
  return text === undefined ? null : { blockId, text };
};

const verifiedTargetCitations = (
  raw: readonly { blockId: string }[],
  blocks: BlockLookup,
): DocxFolioCitation[] => {
  const seen = new Set<string>();
  const verified: DocxFolioCitation[] = [];
  for (const { blockId } of raw) {
    if (seen.has(blockId)) {
      continue;
    }
    const citation = citationFor(blockId, blocks);
    if (citation === null) {
      continue;
    }
    seen.add(blockId);
    verified.push(citation);
    if (verified.length === MAX_VERIFIED_CITATIONS_PER_FINDING) {
      break;
    }
  }
  return verified;
};

const deltaValue = (
  raw: {
    text: string;
    value: number | null;
    unit: string | null;
    blockId: string;
  },
  blocks: BlockLookup,
): DeltaValue | null => {
  const citation = citationFor(raw.blockId, blocks);
  const text = raw.text.trim();
  if (citation === null || text.length === 0) {
    return null;
  }
  return { text, value: raw.value, unit: raw.unit?.trim() || null, citation };
};

/**
 * Narrow the flat model delta into the typed one, keeping only what the
 * documents actually support. A structured claim that cannot be located
 * degrades to `language`, the weakest claim, rather than being dropped: the
 * difference is still real, it is just no longer a term the engine can point at.
 */
const normalizeDelta = (
  raw: RawFinding["delta"],
  targetBlocks: BlockLookup,
  standardBlocks: BlockLookup,
): ReviewDelta => {
  switch (raw.kind) {
    case "parameter": {
      const target =
        raw.targetValue === null
          ? null
          : deltaValue(raw.targetValue, targetBlocks);
      const standard =
        raw.standardValue === null
          ? null
          : deltaValue(raw.standardValue, standardBlocks);
      return target === null && standard === null
        ? LANGUAGE_DELTA
        : { kind: "parameter", target, standard };
    }
    case "enumeration": {
      const items: DeltaEnumerationItem[] = [];
      for (const item of raw.items) {
        const label = item.label.trim();
        if (label.length === 0) {
          continue;
        }
        items.push({
          label,
          inTarget: item.inTarget,
          inStandard: item.inStandard,
          citation:
            item.blockId === null
              ? null
              : citationFor(item.blockId, targetBlocks),
        });
      }
      return items.length === 0
        ? LANGUAGE_DELTA
        : { kind: "enumeration", items };
    }
    case "presence": {
      const term = raw.term.trim();
      return term.length === 0
        ? LANGUAGE_DELTA
        : {
            kind: "presence",
            term,
            inTarget: raw.inTarget,
            inStandard: raw.inStandard,
          };
    }
    case "language":
      return LANGUAGE_DELTA;
    default:
      raw.kind satisfies never;
      return LANGUAGE_DELTA;
  }
};

/**
 * Whether the conclusion rests on something the documents actually say. A
 * position's passages are pinned and verified when it is created, so only the
 * target side has to be proven here; `not-comparable` asserts by name that it
 * has no grounding at all.
 */
const isGrounded = (
  assessment: ReferenceAssessment,
  hasTargetCitation: boolean,
): boolean => {
  switch (assessment) {
    case "aligned":
    case "different":
    case "additional-in-target":
    case "deal-specific":
      return hasTargetCitation;
    // The evidence for an omission is the standard, not the document that
    // omits it; the target has nothing to quote.
    case "missing-from-target":
      return true;
    case "not-comparable":
      return false;
    default:
      assessment satisfies never;
      return false;
  }
};

const normalizeConsensus = (
  consensus: ReferenceConsensus,
  sourceCount: number,
): ReferenceConsensus => {
  if (sourceCount <= 1) {
    return "single";
  }
  switch (consensus) {
    case "mixed":
      return "mixed";
    case "consistent":
    case "single":
      return "consistent";
    default:
      consensus satisfies never;
      return "consistent";
  }
};

/** The position's own passages, grouped by the document they came from. This
 *  is the standard by construction, so it does not depend on what the model
 *  chose to cite back. */
const passageCitations = (
  passages: readonly ReferencePassage[],
): ReferenceGrading["referenceCitations"] => {
  const byFileFieldId = new Map<string, DocxFolioCitation[]>();
  for (const passage of passages) {
    const citations = byFileFieldId.get(passage.fileFieldId);
    const citation: DocxFolioCitation = {
      blockId: passage.blockId,
      text: passage.text,
    };
    if (citations === undefined) {
      byFileFieldId.set(passage.fileFieldId, [citation]);
    } else {
      citations.push(citation);
    }
  }
  return [...byFileFieldId].map(([fileFieldId, citations]) => ({
    fileFieldId: brandPersistedFieldId(fileFieldId),
    citations,
  }));
};

/** The judgment a position falls back to when the model said nothing about
 *  it: flagged for a human rather than silently passed. */
export const ungradedReferenceGrading = (
  position: ReferenceStandardPosition,
): ReferenceGrading => ({
  verdict: ASSESSMENT_VERDICTS["not-comparable"],
  delta: LANGUAGE_DELTA,
  consensus: normalizeConsensus(
    "single",
    new Set(position.passages.map((passage) => passage.fileFieldId)).size,
  ),
  impact: "unknown",
  explanation: { type: "insufficient-evidence" },
  recommendation: null,
  citations: [],
  referenceCitations: passageCitations(position.passages),
  fix: null,
});

/** A quantity's impact is arithmetic; every other kind is the model's to
 *  report, and no named side means no direction at all. */
const referenceImpact = ({
  delta,
  raw,
  perspective,
}: {
  delta: ReviewDelta;
  raw: RawFinding;
  perspective: ReviewPerspective;
}): ReferenceImpact => {
  if (delta.kind === "parameter") {
    return deriveParameterImpact({
      direction: raw.direction,
      delta,
      perspective,
    });
  }
  return perspective.type === "neutral" ? "unknown" : raw.impact;
};

type NormalizeArgs = {
  raw: RawFinding;
  position: ReferenceStandardPosition;
  targetBlocks: BlockLookup;
  perspective: ReviewPerspective;
};

export const normalizeReferenceGrading = ({
  raw,
  position,
  targetBlocks,
  perspective,
}: NormalizeArgs): ReferenceGrading => {
  const citations = verifiedTargetCitations(raw.targetCitations, targetBlocks);
  const grounded = isGrounded(raw.assessment, citations.length > 0);
  if (!grounded) {
    return ungradedReferenceGrading(position);
  }

  const standardBlocks = new Map(
    position.passages.map((passage) => [passage.blockId, passage.text]),
  );
  const delta = normalizeDelta(raw.delta, targetBlocks, standardBlocks);
  const impact = referenceImpact({ delta, raw, perspective });
  const recommendation = raw.recommendation.trim();

  return {
    verdict: ASSESSMENT_VERDICTS[raw.assessment],
    delta,
    consensus: normalizeConsensus(
      raw.consensus,
      new Set(position.passages.map((passage) => passage.fileFieldId)).size,
    ),
    impact,
    explanation: { type: "comparison", text: raw.rationale.trim() },
    recommendation: recommendation.length > 0 ? recommendation : null,
    citations,
    referenceCitations: passageCitations(position.passages),
    fix: buildGroundedReviewFix({
      delta,
      proposedText: raw.proposedText,
      supportingEvidenceVerified: true,
      targetAnchors: citations,
    }),
  };
};

// ── The call ──────────────────────────────────────────

const SYSTEM_PROMPT = `You compare one target legal document against a standard, position by position.

Each position gives an issue and the passages that define the standard for it. Those passages come from a document someone already negotiated: they are an example, not policy and not proof of market practice. Never call the target compliant, non-compliant, standard, or non-standard. Compare substantive drafting only.

Answer every supplied position exactly once and preserve its positionId exactly. Classify the target as aligned, different, missing-from-target, additional-in-target, deal-specific, or not-comparable. Set consensus to mixed when the standard's own passages materially disagree with each other. Cite only exact block IDs supplied in the input; target citations must be blocks of the target document, and any standard block ID must be one of that position's passages. In rationale and recommendation write "the target" and "the standard"; never write source keys. rationale states what each side does on the issue and how they differ, in plain drafting terms. recommendation is one imperative sentence telling the drafter what to change in the target, or an empty string when nothing should change.

delta says what KIND of difference this is, which decides how it is shown and edited:
- parameter: one stated quantity differs (a period, a cap, a threshold, a percentage). Set targetValue and standardValue: text is the term exactly as that side's block writes it (for example "12 months"), value is its number, unit is its unit ("months", "PLN", "%"), blockId is the block stating it. Set either side to null when it states no such term.
- enumeration: a list differs by its limbs. Set items, one entry per limb, with inTarget and inStandard, and blockId of the target block when the target has it.
- presence: one defined term or concept is present on one side and absent on the other. Set term, inTarget, inStandard.
- language: the difference is wording, not structure. Set no other delta fields.
Fill only the fields the chosen kind needs; leave targetValue and standardValue null, items empty, term empty and the booleans false otherwise.

direction applies to a parameter delta only: say whether a HIGHER or a LOWER value of that quantity favours the side the drafter acts for, or unknown when it cannot be told. Do not judge who benefits; the direction plus the numbers decide that.

impact applies to the other delta kinds: unfavourable when the target leaves the drafter's side worse off than the standard does, favourable when better off, neutral when it makes no difference, unknown when no side was named.

proposedText is the wording that should replace or be added to the target, taken from or grounded in the standard's passages; null unless the passages directly support a concrete edit. For a parameter delta proposedText is ignored: the term itself is replaced.`;

const NEUTRAL_PERSPECTIVE_LINE = "No side is named; report impact as unknown.";

const perspectiveLine = (perspective: ReviewPerspective): string => {
  switch (perspective.type) {
    case "party":
      return `The drafter acts for ${perspectivePartyPhrase(perspective)}, a party to the target. The standard's passages may name that side differently; judge for the side that plays the same role.`;
    case "neutral":
      return NEUTRAL_PERSPECTIVE_LINE;
    default:
      return perspective satisfies never;
  }
};

/** The positions region: what changes between calls, so it is placed after the
 *  cached target document rather than before it. */
const buildPositionsPart = (
  positions: readonly ReferenceStandardPosition[],
  perspective: ReviewPerspective,
): string => {
  const guide = positions
    .map((position) => {
      const passages = position.passages
        .map(
          (passage) =>
            `    - blockId=${passage.blockId}\n      text=${passage.text}`,
        )
        .join("\n");
      const guidance =
        position.guidance === undefined || position.guidance.length === 0
          ? ""
          : `\n  reviewer guidance=${position.guidance}`;
      return `- positionId=${position.sourceId}\n  issue=${position.issue}${guidance}\n  standard passages:\n${passages}`;
    })
    .join("\n");
  return `${perspectiveLine(perspective)}\n\nPositions:\n${guide}`;
};

export type GradeReferencePositionsArgs = {
  positions: readonly ReferenceStandardPosition[];
  target: PreparedDocxFile;
  perspective: ReviewPerspective;
  targetEntityVersionId: SafeId<"entityVersion">;
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
};

/** Grade one batch of reference-standard positions. Keyed by `sourceId`; a
 *  position the model skipped is simply absent, and the caller decides what an
 *  absent answer means. */
export const gradeReferencePositions = async ({
  positions,
  target,
  perspective,
  targetEntityVersionId,
  referenceEntityVersionIds,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  abortSignal,
}: GradeReferencePositionsArgs): Promise<
  Result<Map<string, ReferenceGrading>, WorkflowIntegrationError>
> => {
  const caching = resolveCaching({
    promptCachingEnabled,
    role: REFERENCE_GRADE_ROLE,
    scopeKey: reviewDocumentsScopeKey(
      targetEntityVersionId,
      referenceEntityVersionIds,
    ),
  });
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "document-review.references",
    modelRole: REFERENCE_GRADE_ROLE,
    orgAIConfig,
    properties: {
      file_count: 1,
      organization_id: organizationId,
      workspace_id: workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering,
  });

  return await Result.tryPromise({
    try: async () => {
      const output = await generateTanStackObjectForRole({
        role: REFERENCE_GRADE_ROLE,
        orgAIConfig,
        organizationId,
        analytics: aiAnalytics,
        caching,
        serviceTier,
        tenantWorkspaceIds: [workspaceId],
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...buildReviewDocumentParts({ target, references: [], caching }),
              {
                type: "text",
                content: buildPositionsPart(positions, perspective),
              },
            ],
          },
        ],
        abortSignal: AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(REFERENCE_GRADE_TIMEOUT_MS),
        ]),
        outputSchema: referenceGradeSchema,
      });

      const targetBlocks = new Map(
        target.blocks.map((block) => [block.id, block.text]),
      );
      const positionById = new Map(
        positions.map((position) => [position.sourceId, position]),
      );
      const graded = new Map<string, ReferenceGrading>();
      for (const raw of output.findings) {
        const position = positionById.get(raw.positionId);
        if (position === undefined || graded.has(raw.positionId)) {
          continue;
        }
        graded.set(
          raw.positionId,
          normalizeReferenceGrading({
            raw,
            position,
            targetBlocks,
            perspective,
          }),
        );
      }
      return graded;
    },
    catch: (cause) => {
      aiAnalytics.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Reference position grading failed",
        cause,
      });
    },
  });
};
