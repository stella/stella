import { Result } from "better-result";

import type { VerdictMatchedRef } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  AskExtraction,
  DocxFolioCitation,
} from "@/api/lib/document-review/review-extract";
import {
  buildGroundedReviewFix,
  type GroundedReviewFix,
} from "@/api/lib/grounded-review-fix";
import type {
  Position,
  PositionSeverity,
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

// Ephemeral grading for the single-doc review: grade each position from the
// in-memory ASK value (never the DB) using the same per-rule graders
// `computeVerdictBatch` applies to persisted fields. The output is a `Finding`
// per position — the single unit the review endpoint returns.

// A one-click redline aligned with the folio editor's AI-edit op vocabulary
// (`packages/folio` ai-edits/types.ts: `replaceBlock` / `insertAfterBlock`) so
// the frontend can feed it straight into `applyAIEditOperations`.
export type ReviewFix = GroundedReviewFix;

export type ReviewFinding = {
  positionId: string;
  issue: string;
  severity: PositionSeverity;
  // null for extract-only positions (a value column with no verdict).
  verdict: VerdictTier | null;
  extracted: ExtractedAskValue | null;
  rationale: string | null;
  // The resolved tier reference a tier-match verdict cited (which fallback
  // matched, or which red line was violated). Absent for deterministic or
  // unmatched verdicts.
  matchedRef?: VerdictMatchedRef;
  citations: DocxFolioCitation[];
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
  usageMetering?: AIUsageMetering | undefined;
};

export type BuildFindingsArgs = AiGradingDeps & {
  positions: readonly Position[];
  contentBySourceId: ReadonlyMap<string, AskExtraction>;
  tiersBySourceId: ReadonlyMap<string, ResolvedTiers>;
};

type GradedVerdict = {
  verdict: VerdictTier | null;
  rationale: string | null;
  matchedRef?: VerdictMatchedRef;
};

// A replacement is safe only for a located deviation. A missing clause has no
// semantically verified insertion anchor, so it remains a finding until the
// reviewer chooses where it belongs.
const buildFix = ({
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
    kind: "replaceBlock",
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
const UNGRADED_VERDICT: GradedVerdict = {
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
}): GradedVerdict | null => {
  // Extract-only positions capture a value with no verdict.
  if (position.mode === "extract") {
    return { verdict: null, rationale: null };
  }

  const { check } = position;
  if (check?.kind === "presence") {
    return {
      verdict: gradePresence(check.expectation, askPresence(askContent)),
      rationale: null,
    };
  }
  if (check?.kind === "constraint") {
    // The condition references the position's own value via a `property` operand
    // whose id is the position sourceId, so it resolves against the
    // sourceId-keyed content map directly (no materialized-property remap).
    return {
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
    return { verdict: "missing", rationale: null };
  }
  return null;
};

const toGradedVerdict = (graded: {
  tier: VerdictTier;
  rationale: string;
  matchedRef?: VerdictMatchedRef;
}): GradedVerdict => ({
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
}): Promise<ReadonlyMap<string, GradedVerdict>> => {
  const verdicts = new Map<string, GradedVerdict>();
  for (
    let cursor = 0;
    cursor < positions.length;
    cursor += TIER_MATCH_BATCH_SIZE
  ) {
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

export const buildFindings = async ({
  positions,
  contentBySourceId,
  tiersBySourceId,
  ...deps
}: BuildFindingsArgs): Promise<ReviewFinding[]> => {
  const fieldContentBySourceId = new Map<string, FieldContent>();
  for (const [sourceId, extraction] of contentBySourceId) {
    fieldContentBySourceId.set(sourceId, extraction.content);
  }

  // Everything decidable without the model is decided first; what is left
  // goes to the model in batches. Findings keep the input `positions` order.
  const decided = new Map<string, GradedVerdict>();
  const forModel: Position[] = [];
  for (const position of positions) {
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
  const modelVerdicts = await gradeTierMatchPositions({
    positions: forModel,
    contentBySourceId,
    tiersBySourceId,
    deps,
  });

  return positions.map((position): ReviewFinding => {
    const extraction = contentBySourceId.get(position.sourceId);
    const askContent = extraction?.content;
    const tiers = tiersBySourceId.get(position.sourceId);
    // Persisted findings keep the folio-only citation shape used by the
    // inspector. The ephemeral extractor also retains PDF citations, which
    // chat consumers read directly before this compatibility projection.
    const citations = arrayOrEmpty(extraction?.citations)
      .filter((citation) => citation.kind === "docx-folio")
      .map(({ blockId, text }): DocxFolioCitation => ({ blockId, text }));
    const { verdict, rationale, matchedRef } =
      decided.get(position.sourceId) ??
      modelVerdicts.get(position.sourceId) ??
      UNGRADED_VERDICT;

    return {
      positionId: position.sourceId,
      issue: position.issue,
      // Severity is meaningless on extract-only positions (they never surface a
      // verdict finding); use the neutral tier as a placeholder.
      severity: position.mode === "graded" ? position.severity : "medium",
      verdict,
      extracted: extractedFromContent(askContent),
      rationale,
      ...(matchedRef === undefined ? {} : { matchedRef }),
      citations,
      fix: buildFix({
        verdict,
        citations,
        ideal: tiers?.ideal,
      }),
    };
  });
};
