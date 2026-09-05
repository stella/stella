import { panic, Result } from "better-result";

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
import type { PinnedReferencePassage } from "@/api/lib/document-review/reference-passages";
import { LANGUAGE_DELTA } from "@/api/lib/document-review/review-delta";
import type { ReviewDelta } from "@/api/lib/document-review/review-delta";
import type {
  AskExtraction,
  DocxFolioCitation,
} from "@/api/lib/document-review/review-extract";
import { resolveReviewTargetLanguage } from "@/api/lib/document-review/target-language";
import type { ReviewTargetLanguage } from "@/api/lib/document-review/target-language";
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
  /** The standard's own passages, grouped by the document they came from.
   *  Ids only: the words live in their source matter's rows and reach a
   *  reader through that matter's row security, never through the finding. */
  referenceCitations?: {
    fileFieldId: SafeId<"field">;
    passages: { id: string; blockId: string }[];
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
  /** External model-dispatch boundaries; supplied by focused tests. */
  gradeTierMatches?: typeof gradeTierMatches | undefined;
  gradeReferencePositions?: typeof gradeReferencePositions | undefined;
};

/**
 * Findings a grading batch has just produced, handed over the moment that
 * batch returns rather than when the whole pass ends. A review of twenty terms
 * takes several model calls; the reviewer watching it should see the count
 * move after each one, not once at the end.
 */
export type OnFindingsGraded = (
  findings: readonly ReviewFinding[],
) => Promise<void>;

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
  /** The words behind every passage the positions pin, keyed by passage id.
   *  A passage whose row is gone is graded as if it were never quoted. */
  passageTextById: ReadonlyMap<string, string>;
  /** Progress, per completed batch. The full set still comes back from the
   *  return value; this only lets a caller commit early. */
  onGraded: OnFindingsGraded;
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
 * where it belongs. Ideal language is authored, not generated, so one written
 * in another language than the document's yields a finding without a fix.
 */
const buildTierFix = ({
  verdict,
  citations,
  ideal,
  targetLanguage,
}: {
  verdict: VerdictTier | null;
  citations: readonly DocxFolioCitation[];
  ideal: string | undefined;
  targetLanguage: ReviewTargetLanguage;
}): ReviewFix | null => {
  if (verdict !== "deviation") {
    return null;
  }
  return buildGroundedReviewFix({
    delta: LANGUAGE_DELTA,
    proposedText: ideal,
    supportingEvidenceVerified: true,
    targetAnchors: citations,
    targetLanguage,
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
 *
 * Verdicts land in `verdicts` as each batch returns, and `emit` is handed the
 * batch that just landed, so progress is committed per call.
 */
const gradeTierMatchPositions = async ({
  positions,
  contentBySourceId,
  tiersBySourceId,
  deps,
  verdicts,
  emit,
}: {
  positions: readonly Position[];
  contentBySourceId: ReadonlyMap<string, AskExtraction>;
  tiersBySourceId: ReadonlyMap<string, ResolvedTiers>;
  deps: AiGradingDeps;
  verdicts: Map<string, GradingOutcome>;
  emit: (batch: readonly Position[]) => Promise<void>;
}): Promise<void> => {
  const gradeTierMatchesForReview = deps.gradeTierMatches ?? gradeTierMatches;
  for (
    let cursor = 0;
    cursor < positions.length;
    cursor += TIER_MATCH_BATCH_SIZE
  ) {
    if (deps.abortSignal.aborted) {
      break;
    }
    const batch = positions.slice(cursor, cursor + TIER_MATCH_BATCH_SIZE);
    const graded = await gradeTierMatchesForReview({
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
    await emit(batch);
  }
};

/** A reference-standard position, paired with the position it came from so a
 *  finished batch can be projected into findings without a second lookup. */
type ReferencePair = {
  position: Position;
  reference: ReferenceStandardPosition;
};

/** A reference-standard position, as the reference grader reads it: its
 *  pinned passages with their words attached. A passage whose row no longer
 *  exists is left out; a position left with none is graded as ungrounded. */
const referencePair = (
  position: Position,
  passageTextById: ReadonlyMap<string, string>,
): ReferencePair | null => {
  if (position.mode !== "graded" || position.standard.source !== "reference") {
    return null;
  }
  const passages: PinnedReferencePassage[] = [];
  for (const passage of position.standard.passages) {
    const text = passageTextById.get(passage.id);
    if (text !== undefined) {
      passages.push({ ...passage, text });
    }
  }
  return {
    position,
    reference: {
      sourceId: position.sourceId,
      issue: position.issue,
      termKind: position.standard.termKind,
      guidance: position.guidance,
      passages,
    },
  };
};

/** Reference-standard batches in flight at once. Each call sends the shared
 *  target/reference document parts (cached by scope key) plus one batch's
 *  passages, so several in flight overlap that latency instead of paying it
 *  once per batch, without letting one review's fan-out grow unbounded. */
const REFERENCE_GRADE_CONCURRENCY = 3;

/** Runs `batches` with up to `concurrency` calls in flight. A worker claims
 *  the next unstarted batch in order — so batches begin in position order —
 *  then awaits `onBatch` before claiming another, which is what lets a
 *  finished batch hand its results over the moment it lands rather than when
 *  the slowest concurrent batch also finishes. Stops claiming new batches,
 *  without cancelling ones already in flight, once `abortSignal` fires. */
const runBatchesWithConcurrency = async <Batch>({
  batches,
  concurrency,
  abortSignal,
  onBatch,
}: {
  batches: readonly Batch[];
  concurrency: number;
  abortSignal: AbortSignal;
  onBatch: (batch: Batch) => Promise<void>;
}): Promise<void> => {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (abortSignal.aborted) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      const batch = batches.at(index);
      if (batch === undefined) {
        return;
      }
      await onBatch(batch);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, worker),
  );
};

/**
 * Compare the target against every reference-standard position, a batch of
 * positions per model call, up to {@link REFERENCE_GRADE_CONCURRENCY} batches
 * at once. A batch that fails, or a position the model skipped, leaves that
 * position ungraded rather than failing the run: one unanswerable position
 * must not discard the rest of the review.
 */
const gradeReferenceStandards = async ({
  pairs,
  target,
  targetLanguage,
  perspective,
  referenceEntityVersionIds,
  deps,
  gradings,
  emit,
}: {
  pairs: readonly ReferencePair[];
  target: PreparedDocxFile;
  targetLanguage: ReviewTargetLanguage;
  perspective: ReviewPerspective;
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[];
  deps: AiGradingDeps;
  gradings: Map<string, ReferenceGrading>;
  emit: (batch: readonly Position[]) => Promise<void>;
}): Promise<void> => {
  const gradeReferencePositionsForReview =
    deps.gradeReferencePositions ?? gradeReferencePositions;
  const batches: ReferencePair[][] = [];
  for (
    let cursor = 0;
    cursor < pairs.length;
    cursor += REFERENCE_GRADE_BATCH_SIZE
  ) {
    batches.push(pairs.slice(cursor, cursor + REFERENCE_GRADE_BATCH_SIZE));
  }

  await runBatchesWithConcurrency({
    batches,
    concurrency: REFERENCE_GRADE_CONCURRENCY,
    abortSignal: deps.abortSignal,
    onBatch: async (batch) => {
      const outcome = await gradeReferencePositionsForReview({
        positions: batch.map((pair) => pair.reference),
        target,
        targetLanguage,
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
      for (const { reference } of batch) {
        const grading = Result.isOk(outcome)
          ? outcome.value.get(reference.sourceId)
          : undefined;
        gradings.set(
          reference.sourceId,
          grading ?? ungradedReferenceGrading(reference),
        );
      }
      // Findings still land in the caller's `positions` order: `emit` only
      // hands over progress, and the pass's return value re-projects the
      // whole set from `gradings` in that order once every worker is done.
      await emit(batch.map((pair) => pair.position));
    },
  });
};

type ProjectGradingArgs = {
  grading: GradingOutcome;
  citations: readonly DocxFolioCitation[];
  ideal: string | undefined;
  targetLanguage: ReviewTargetLanguage;
};

type ProjectedGrading = Pick<
  ReviewFinding,
  "verdict" | "rationale" | "matchedRef" | "fix"
>;

const projectGrading = ({
  grading,
  citations,
  ideal,
  targetLanguage,
}: ProjectGradingArgs): ProjectedGrading => {
  switch (grading.status) {
    case "graded":
      return {
        verdict: grading.verdict,
        rationale: grading.rationale,
        ...(grading.matchedRef === undefined
          ? {}
          : { matchedRef: grading.matchedRef }),
        fix: buildTierFix({
          verdict: grading.verdict,
          citations,
          ideal,
          targetLanguage,
        }),
      };
    case "ungraded":
      return {
        verdict: grading.verdict,
        rationale: grading.rationale,
        fix: null,
      };
    default:
      grading satisfies never;
      return panic(`Unhandled grading: ${String(grading)}`);
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
  passageTextById,
  onGraded,
  ...deps
}: BuildFindingsArgs): Promise<ReviewFinding[]> => {
  const fieldContentBySourceId = new Map<string, FieldContent>();
  for (const [sourceId, extraction] of contentBySourceId) {
    fieldContentBySourceId.set(sourceId, extraction.content);
  }

  // Split on where the standard came from, then decide everything that needs
  // no model, then hand the rest to the two graders. Findings keep the input
  // `positions` order.
  const referencePairs: ReferencePair[] = [];
  const decided = new Map<string, GradingOutcome>();
  const forModel: Position[] = [];
  for (const position of positions) {
    const pair = referencePair(position, passageTextById);
    if (pair !== null) {
      referencePairs.push(pair);
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

  // Both graders fill these as their batches land, and `project` reads them at
  // call time — which is what lets a completed batch be handed over before the
  // pass is finished.
  const modelVerdicts = new Map<string, GradingOutcome>();
  const referenceGradings = new Map<string, ReferenceGrading>();
  const targetLanguage = resolveReviewTargetLanguage(target);
  const project = (position: Position): ReviewFinding =>
    projectFinding({
      position,
      passageTextById,
      contentBySourceId,
      tiersBySourceId,
      decided,
      modelVerdicts,
      referenceGradings,
      targetLanguage,
    });
  const emit = async (batch: readonly Position[]): Promise<void> => {
    await onGraded(batch.map(project));
  };

  await Promise.all([
    gradeTierMatchPositions({
      positions: forModel,
      contentBySourceId,
      tiersBySourceId,
      deps,
      verdicts: modelVerdicts,
      emit,
    }),
    gradeReferenceStandards({
      pairs: referencePairs,
      target,
      targetLanguage,
      perspective,
      referenceEntityVersionIds,
      deps,
      gradings: referenceGradings,
      emit,
    }),
  ]);

  return positions.map(project);
};

type ProjectFindingArgs = {
  position: Position;
  passageTextById: ReadonlyMap<string, string>;
  contentBySourceId: ReadonlyMap<string, AskExtraction>;
  tiersBySourceId: ReadonlyMap<string, ResolvedTiers>;
  decided: ReadonlyMap<string, GradingOutcome>;
  modelVerdicts: ReadonlyMap<string, GradingOutcome>;
  referenceGradings: ReadonlyMap<string, ReferenceGrading>;
  targetLanguage: ReviewTargetLanguage;
};

/** One position plus whatever has been decided about it, as the single
 *  finding shape. Pure: called once per position for the batch that graded it,
 *  and again for the ordered set the pass returns. */
const projectFinding = ({
  position,
  passageTextById,
  contentBySourceId,
  tiersBySourceId,
  decided,
  modelVerdicts,
  referenceGradings,
  targetLanguage,
}: ProjectFindingArgs): ReviewFinding => {
  const pair = referencePair(position, passageTextById);
  if (pair !== null) {
    // A reference position the grader never reached keeps the flagged-for-a-
    // human answer rather than falling through to the tier path, which would
    // read its silence as a wording deviation.
    return referenceFinding(
      position,
      referenceGradings.get(position.sourceId) ??
        ungradedReferenceGrading(pair.reference),
    );
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
    targetLanguage,
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
};
