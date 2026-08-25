import { Result } from "better-result";

import type { VerdictMatchedRef } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  ReferenceConsensus,
  ReferenceImpact,
  ReviewPerspective,
} from "@/api/lib/document-review/contract";
import {
  gradeReferencePositions,
  REFERENCE_GRADE_BATCH_SIZE,
  ungradedReferenceGrading,
} from "@/api/lib/document-review/reference-grade";
import type {
  ReferenceGrading,
  ReferenceStandardPosition,
} from "@/api/lib/document-review/reference-grade";
import { LANGUAGE_DELTA } from "@/api/lib/document-review/review-delta";
import type { ReviewDelta } from "@/api/lib/document-review/review-delta";
import type {
  AskExtraction,
  DocxFolioCitation,
} from "@/api/lib/document-review/review-extract";
import {
  buildGroundedReviewFix,
  type GroundedReviewFix,
} from "@/api/lib/grounded-review-fix";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import type {
  Position,
  PositionSeverity,
  PositionStandardSource,
  ResolvedTiers,
} from "@/api/lib/workflow/playbook-positions";
import {
  askPresence,
  askText,
  extractedFromContent,
  gradePresence,
  gradePropertyConstraint,
  gradeTierMatches,
  TIER_MATCH_BATCH_SIZE,
} from "@/api/lib/workflow/verdict-engine";
import type { ExtractedAskValue } from "@/api/lib/workflow/verdict-engine";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

// Ephemeral grading for one document: every enabled position produces exactly
// one finding, whether its standard is an authored tier ladder or the passages
// of a reference document. Grading dispatches on `standard.source`; everything
// downstream — the row, the fix, the export — sees one finding shape.

/** A one-click redline, derived from the finding's delta, in the folio
 *  editor's AI-edit op vocabulary. */
export type ReviewFix = GroundedReviewFix;

export type ReviewFinding = {
  positionId: string;
  issue: string;
  severity: PositionSeverity;
  /** Where the standard this was graded against came from. Kept on the
   *  finding so a reader knows what the judgment rests on without re-reading
   *  the run's pinned position list. */
  standardSource: PositionStandardSource;
  // null for extract-only positions (a value column with no verdict).
  verdict: VerdictTier | null;
  /** What differs, typed. The fix is derived from this, never free-formed. */
  delta: ReviewDelta;
  extracted: ExtractedAskValue | null;
  rationale: string | null;
  // The resolved tier reference a tier-match verdict cited (which fallback
  // matched, or which red line was violated). Absent for deterministic or
  // unmatched verdicts.
  matchedRef?: VerdictMatchedRef;
  /** How consistently the standard's own passages agreed. Reference standards
   *  only: an authored ladder is one voice by construction. */
  consensus?: ReferenceConsensus;
  /** Which way the difference cuts for the side the run was judged for. */
  impact?: ReferenceImpact;
  /** The comparison in prose, or the statement that there was not enough to
   *  compare. Reference standards only; a tier match explains itself through
   *  `rationale` and `matchedRef`. */
  explanation?:
    | { type: "comparison"; text: string }
    | { type: "insufficient-evidence" };
  /** One instruction for the drafter, or `null` when nothing should change. */
  recommendation?: string | null;
  citations: DocxFolioCitation[];
  /** The standard's own passages, grouped by the document they came from. */
  referenceCitations?: {
    fileFieldId: SafeId<"field">;
    citations: DocxFolioCitation[];
  }[];
  fix: ReviewFix | null;
};

type AiGradingDeps = {
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
};

export type BuildFindingsArgs = AiGradingDeps & {
  positions: readonly Position[];
  contentBySourceId: ReadonlyMap<string, AskExtraction>;
  tiersBySourceId: ReadonlyMap<string, ResolvedTiers>;
  /** The prepared target, compared directly against a reference standard's
   *  passages. */
  target: PreparedDocxFile;
  /** The side reference comparisons are judged for. */
  perspective: ReviewPerspective;
  /** Pinned reference versions, for the shared prompt cache scope. */
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[];
};

type GradingOutcome =
  | {
      status: "graded";
      verdict: VerdictTier | null;
      rationale: string | null;
      matchedRef?: VerdictMatchedRef;
    }
  | {
      status: "ungraded";
      verdict: "deviation";
      rationale: string;
    };

/**
 * A tier deviation replaces the block it was found in with the position's
 * ideal language: the difference is wording, so the delta is `language` and
 * the op is a whole-block replacement. A missing clause has no semantically
 * verified insertion anchor, so it stays a finding until a reviewer chooses
 * where it belongs.
 */
const buildTierFix = ({
  verdict,
  citations,
  ideal,
}: {
  verdict: VerdictTier | null;
  citations: readonly DocxFolioCitation[];
  ideal: string | undefined;
}): ReviewFix | null => {
  if (verdict !== "deviation") {
    return null;
  }
  return buildGroundedReviewFix({
    delta: LANGUAGE_DELTA,
    proposedText: ideal,
    supportingEvidenceVerified: true,
    targetAnchors: citations,
  });
};

const EMPTY_TIERS: ResolvedTiers = {
  fallbacks: [],
  acceptableRules: [],
  notAcceptableRules: [],
};

// A failed or absent compare must not silently pass: the finding is flagged
// for human review, mirroring the engine's "no criteria configured" fallback.
const UNGRADED_VERDICT: GradingOutcome = {
  status: "ungraded",
  verdict: "deviation",
  rationale:
    "Automated comparison against the standard could not be completed.",
};

/**
 * Everything a position decides without a model: extract-only positions,
 * deterministic checks, and a tier-match position whose value is missing.
 * `null` means the position needs the model's tier-match.
 */
const gradeWithoutModel = ({
  position,
  askContent,
  fieldContentBySourceId,
}: {
  position: Position;
  askContent: FieldContent | undefined;
  fieldContentBySourceId: ReadonlyMap<string, FieldContent>;
}): GradingOutcome | null => {
  // Extract-only positions capture a value with no verdict.
  if (position.mode === "extract") {
    return { status: "graded", verdict: null, rationale: null };
  }

  const { check } = position;
  if (check?.kind === "presence") {
    return {
      status: "graded",
      verdict: gradePresence(check.expectation, askPresence(askContent)),
      rationale: null,
    };
  }
  if (check?.kind === "constraint") {
    // The condition references the position's own value via a `property` operand
    // whose id is the position sourceId, so it resolves against the
    // sourceId-keyed content map directly (no materialized-property remap).
    return {
      status: "graded",
      verdict: gradePropertyConstraint(
        check.condition,
        askContent,
        fieldContentBySourceId,
      ),
      rationale: null,
    };
  }

  const askValue = askText(askContent);
  if (askValue === null || askValue.trim().length === 0) {
    return { status: "graded", verdict: "missing", rationale: null };
  }
  return null;
};

const toGradedVerdict = (graded: {
  tier: VerdictTier;
  rationale: string;
  matchedRef?: VerdictMatchedRef;
}): GradingOutcome => ({
  status: "graded",
  verdict: graded.tier,
  rationale: graded.rationale,
  ...(graded.matchedRef === undefined ? {} : { matchedRef: graded.matchedRef }),
});

/**
 * Tier-match the positions the model has to decide, several per call: one
 * call per {@link TIER_MATCH_BATCH_SIZE} positions instead of one per
 * position, every call under the document's cache scope.
 */
const gradeTierMatchPositions = async ({
  positions,
  contentBySourceId,
  tiersBySourceId,
  deps,
}: {
  positions: readonly Position[];
  contentBySourceId: ReadonlyMap<string, AskExtraction>;
  tiersBySourceId: ReadonlyMap<string, ResolvedTiers>;
  deps: AiGradingDeps;
}): Promise<ReadonlyMap<string, GradingOutcome>> => {
  const verdicts = new Map<string, GradingOutcome>();
  for (
    let cursor = 0;
    cursor < positions.length;
    cursor += TIER_MATCH_BATCH_SIZE
  ) {
    if (deps.abortSignal.aborted) {
      break;
    }
    const batch = positions.slice(cursor, cursor + TIER_MATCH_BATCH_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- one model call per batch, in order, keeps the single-doc review's fan-out bounded
    const graded = await gradeTierMatches({
      items: batch.map((position) => ({
        key: position.sourceId,
        askValue:
          askText(contentBySourceId.get(position.sourceId)?.content) ?? "",
        tiers: tiersBySourceId.get(position.sourceId) ?? EMPTY_TIERS,
      })),
      abortSignal: deps.abortSignal,
      organizationId: deps.organizationId,
      workspaceId: deps.workspaceId,
      entityVersionId: deps.entityVersionId,
      orgAIConfig: deps.orgAIConfig,
      promptCachingEnabled: deps.promptCachingEnabled,
      serviceTier: deps.serviceTier,
      usageMetering: deps.usageMetering,
    });
    for (const position of batch) {
      const verdict = Result.isOk(graded)
        ? graded.value.get(position.sourceId)
        : undefined;
      verdicts.set(
        position.sourceId,
        verdict === undefined ? UNGRADED_VERDICT : toGradedVerdict(verdict),
      );
    }
  }
  return verdicts;
};

/** A reference-standard position, as the reference grader reads it. */
const referenceStandardPosition = (
  position: Position,
): ReferenceStandardPosition | null => {
  if (position.mode !== "graded" || position.standard.source !== "reference") {
    return null;
  }
  return {
    sourceId: position.sourceId,
    issue: position.issue,
    guidance: position.guidance,
    passages: position.standard.passages,
  };
};

/**
 * Compare the target against every reference-standard position, a batch of
 * positions per model call. A batch that fails, or a position the model
 * skipped, leaves that position ungraded rather than failing the run: one
 * unanswerable position must not discard the rest of the review.
 */
const gradeReferenceStandards = async ({
  positions,
  target,
  perspective,
  referenceEntityVersionIds,
  deps,
}: {
  positions: readonly ReferenceStandardPosition[];
  target: PreparedDocxFile;
  perspective: ReviewPerspective;
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[];
  deps: AiGradingDeps;
}): Promise<ReadonlyMap<string, ReferenceGrading>> => {
  const graded = new Map<string, ReferenceGrading>();
  if (positions.length === 0) {
    return graded;
  }
  for (
    let cursor = 0;
    cursor < positions.length;
    cursor += REFERENCE_GRADE_BATCH_SIZE
  ) {
    const batch = positions.slice(cursor, cursor + REFERENCE_GRADE_BATCH_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- one model call per batch, in order, keeps the review's fan-out bounded
    const outcome = await gradeReferencePositions({
      positions: batch,
      target,
      perspective,
      targetEntityVersionId: deps.entityVersionId,
      referenceEntityVersionIds,
      organizationId: deps.organizationId,
      workspaceId: deps.workspaceId,
      orgAIConfig: deps.orgAIConfig,
      promptCachingEnabled: deps.promptCachingEnabled,
      serviceTier: deps.serviceTier,
      usageMetering: deps.usageMetering,
      abortSignal: deps.abortSignal,
    });
    for (const position of batch) {
      const grading = Result.isOk(outcome)
        ? outcome.value.get(position.sourceId)
        : undefined;
      graded.set(
        position.sourceId,
        grading ?? ungradedReferenceGrading(position),
      );
    }
  }
  return graded;
};

type ProjectGradingArgs = {
  grading: GradingOutcome;
  citations: readonly DocxFolioCitation[];
  ideal: string | undefined;
};

type ProjectedGrading = Pick<
  ReviewFinding,
  "verdict" | "rationale" | "matchedRef" | "fix"
>;

const projectGrading = ({
  grading,
  citations,
  ideal,
}: ProjectGradingArgs): ProjectedGrading => {
  switch (grading.status) {
    case "graded":
      return {
        verdict: grading.verdict,
        rationale: grading.rationale,
        ...(grading.matchedRef === undefined
          ? {}
          : { matchedRef: grading.matchedRef }),
        fix: buildTierFix({ verdict: grading.verdict, citations, ideal }),
      };
    case "ungraded":
      return {
        verdict: grading.verdict,
        rationale: grading.rationale,
        fix: null,
      };
    default:
      return grading satisfies never;
  }
};

/** Severity is meaningless on extract-only positions (they never surface a
 *  verdict); the neutral tier stands in so the field is always present. */
const findingSeverity = (position: Position): PositionSeverity =>
  position.mode === "graded" ? position.severity : "medium";

/** An extract-only position measures against nothing, so it has no standard to
 *  name. It reads as `tiers`: it is an authored playbook entry, and its
 *  finding carries no verdict for a reader to attribute to a standard. */
const standardSourceOf = (position: Position): PositionStandardSource =>
  position.mode === "graded" ? position.standard.source : "tiers";

const referenceFinding = (
  position: Position,
  grading: ReferenceGrading,
): ReviewFinding => ({
  positionId: position.sourceId,
  issue: position.issue,
  severity: findingSeverity(position),
  standardSource: "reference",
  verdict: grading.verdict,
  delta: grading.delta,
  // A reference comparison reads the document directly; it extracts no value.
  extracted: null,
  rationale:
    grading.explanation.type === "comparison" ? grading.explanation.text : null,
  consensus: grading.consensus,
  impact: grading.impact,
  explanation: grading.explanation,
  recommendation: grading.recommendation,
  citations: grading.citations,
  referenceCitations: grading.referenceCitations,
  fix: grading.fix,
});

export const buildFindings = async ({
  positions,
  contentBySourceId,
  tiersBySourceId,
  target,
  perspective,
  referenceEntityVersionIds,
  ...deps
}: BuildFindingsArgs): Promise<ReviewFinding[]> => {
  const fieldContentBySourceId = new Map<string, FieldContent>();
  for (const [sourceId, extraction] of contentBySourceId) {
    fieldContentBySourceId.set(sourceId, extraction.content);
  }

  // Split on where the standard came from, then decide everything that needs
  // no model, then hand the rest to the two graders. Findings keep the input
  // `positions` order.
  const referencePositions: ReferenceStandardPosition[] = [];
  const decided = new Map<string, GradingOutcome>();
  const forModel: Position[] = [];
  for (const position of positions) {
    const reference = referenceStandardPosition(position);
    if (reference !== null) {
      referencePositions.push(reference);
      continue;
    }
    const verdict = gradeWithoutModel({
      position,
      askContent: contentBySourceId.get(position.sourceId)?.content,
      fieldContentBySourceId,
    });
    if (verdict === null) {
      forModel.push(position);
    } else {
      decided.set(position.sourceId, verdict);
    }
  }

  const [modelVerdicts, referenceGradings] = await Promise.all([
    gradeTierMatchPositions({
      positions: forModel,
      contentBySourceId,
      tiersBySourceId,
      deps,
    }),
    gradeReferenceStandards({
      positions: referencePositions,
      target,
      perspective,
      referenceEntityVersionIds,
      deps,
    }),
  ]);

  return positions.map((position): ReviewFinding => {
    const referenceGrading = referenceGradings.get(position.sourceId);
    if (referenceGrading !== undefined) {
      return referenceFinding(position, referenceGrading);
    }

    const extraction = contentBySourceId.get(position.sourceId);
    const askContent = extraction?.content;
    const tiers = tiersBySourceId.get(position.sourceId);
    // Persisted findings keep the folio-only citation shape used by the
    // inspector. The ephemeral extractor also retains PDF citations, which
    // chat consumers read directly before this compatibility projection.
    const citations = arrayOrEmpty(extraction?.citations)
      .filter((citation) => citation.kind === "docx-folio")
      .map(({ blockId, text }): DocxFolioCitation => ({ blockId, text }));
    const grading =
      decided.get(position.sourceId) ??
      modelVerdicts.get(position.sourceId) ??
      UNGRADED_VERDICT;
    const { verdict, rationale, matchedRef, fix } = projectGrading({
      grading,
      citations,
      ideal: tiers?.ideal,
    });

    return {
      positionId: position.sourceId,
      issue: position.issue,
      severity: findingSeverity(position),
      standardSource: standardSourceOf(position),
      verdict,
      // A tier match compares wording against a ladder of rules, so the
      // difference it finds is a language one; the structured kinds come from
      // a reference comparison, which reads both sides' text.
      delta: LANGUAGE_DELTA,
      extracted: extractedFromContent(askContent),
      rationale,
      ...(matchedRef === undefined ? {} : { matchedRef }),
      citations,
      fix,
    };
  });
};
