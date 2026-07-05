import { Result } from "better-result";

import type { VerdictMatchedRef } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { GradedPosition } from "@/api/handlers/playbooks/position-runtime";
import type {
  Position,
  PositionSeverity,
  ResolvedTiers,
} from "@/api/handlers/playbooks/positions";
import type {
  AskExtraction,
  DocxFolioCitation,
} from "@/api/handlers/playbooks/review-extract";
import type { VerdictTier } from "@/api/handlers/playbooks/verdict-tiers";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  askPresence,
  askText,
  gradePresence,
  gradePropertyConstraint,
  gradeTierMatch,
  POSITION_MATCH_CONCURRENCY,
} from "@/api/lib/workflow/verdict-engine";

// Ephemeral grading for the single-doc review: grade each position from the
// in-memory ASK value (never the DB) using the same per-rule graders
// `computeVerdictBatch` applies to persisted fields. The output is a `Finding`
// per position — the single unit the review endpoint returns.

// A one-click redline aligned with the folio editor's AI-edit op vocabulary
// (`packages/folio` ai-edits/types.ts: `replaceBlock` / `insertAfterBlock`) so
// the frontend can feed it straight into `applyAIEditOperations`.
export type ReviewFix = {
  kind: "replaceBlock" | "insertAfterBlock";
  blockId: string;
  text: string;
};

export type ReviewFinding = {
  positionId: string;
  issue: string;
  severity: PositionSeverity;
  // null for extract-only positions (a value column with no verdict).
  verdict: VerdictTier | null;
  extracted: { value: string; text: string } | null;
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
  lastBlockId: string | null;
};

type GradedVerdict = {
  verdict: VerdictTier | null;
  rationale: string | null;
  matchedRef?: VerdictMatchedRef;
};

const extractedFromContent = (
  content: FieldContent | undefined,
): { value: string; text: string } | null => {
  if (!content) {
    return null;
  }
  switch (content.type) {
    case "text":
      return { value: content.value, text: content.value };
    case "single-select":
    case "date": {
      const value = content.value ?? "";
      return { value, text: value };
    }
    case "multi-select": {
      const value = content.value.join(", ");
      return { value, text: value };
    }
    case "int": {
      const value = String(content.value);
      const text = content.currency
        ? `${content.value} ${content.currency}`
        : value;
      return { value, text };
    }
    case "file":
    case "clip":
    case "error":
    case "pending":
    case "unsupported":
      return null;
    default: {
      const exhaustive: never = content;
      void exhaustive;
      return null;
    }
  }
};

// FIX targets only an actionable gap: a flagged verdict (deviation/missing) and
// resolved ideal language to insert. A located deviating clause (primary
// citation) is replaced; a missing clause with no citation is appended after the
// last block. Null when there is no anchor or no ideal text.
const buildFix = ({
  verdict,
  citations,
  ideal,
  lastBlockId,
}: {
  verdict: VerdictTier | null;
  citations: readonly DocxFolioCitation[];
  ideal: string | undefined;
  lastBlockId: string | null;
}): ReviewFix | null => {
  if (verdict !== "deviation" && verdict !== "missing") {
    return null;
  }
  const text = ideal?.trim();
  if (!text || text.length === 0) {
    return null;
  }
  // Only a deviation replaces the cited paragraph; a missing clause appends the
  // ideal language after the last block so an unrelated citation attached to a
  // "missing" verdict never overwrites existing document text.
  const primaryBlockId =
    verdict === "deviation" ? citations.at(0)?.blockId : undefined;
  if (primaryBlockId !== undefined) {
    return { kind: "replaceBlock", blockId: primaryBlockId, text };
  }
  if (lastBlockId !== null) {
    return { kind: "insertAfterBlock", blockId: lastBlockId, text };
  }
  return null;
};

// A graded position grades by its deterministic `check` (presence/constraint,
// no LLM) or, without a check, by LLM tier-match against the resolved tiers.
const gradedNeedsTierMatch = (position: Position): position is GradedPosition =>
  position.mode === "graded" && position.check === undefined;

const gradePosition = async ({
  position,
  tiers,
  askContent,
  fieldContentBySourceId,
  deps,
}: {
  position: Position;
  tiers: ResolvedTiers | undefined;
  askContent: FieldContent | undefined;
  fieldContentBySourceId: ReadonlyMap<string, FieldContent>;
  deps: AiGradingDeps;
}): Promise<GradedVerdict> => {
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

  // No check: LLM tier-match.
  const askValue = askText(askContent);
  if (askValue === null || askValue.trim().length === 0) {
    return { verdict: "missing", rationale: null };
  }
  const graded = await gradeTierMatch({
    askValue,
    tiers: tiers ?? {
      fallbacks: [],
      acceptableRules: [],
      notAcceptableRules: [],
    },
    abortSignal: deps.abortSignal,
    organizationId: deps.organizationId,
    workspaceId: deps.workspaceId,
    entityVersionId: deps.entityVersionId,
    // Ephemeral grading materializes no property; this id only tags the
    // analytics trace for the targeted compare.
    propertyId: createSafeId<"property">(),
    orgAIConfig: deps.orgAIConfig,
    promptCachingEnabled: deps.promptCachingEnabled,
    serviceTier: deps.serviceTier,
    usageMetering: deps.usageMetering,
  });
  if (Result.isError(graded)) {
    // A failed compare must not silently pass: flag it for human review,
    // mirroring the engine's "no criteria configured" deviation fallback.
    return {
      verdict: "deviation",
      rationale:
        "Automated comparison against the standard could not be completed.",
    };
  }
  return {
    verdict: graded.value.tier,
    rationale: graded.value.rationale,
    ...(graded.value.matchedRef === undefined
      ? {}
      : { matchedRef: graded.value.matchedRef }),
  };
};

export const buildFindings = async ({
  positions,
  contentBySourceId,
  tiersBySourceId,
  lastBlockId,
  ...deps
}: BuildFindingsArgs): Promise<ReviewFinding[]> => {
  const fieldContentBySourceId = new Map<string, FieldContent>();
  for (const [sourceId, extraction] of contentBySourceId) {
    fieldContentBySourceId.set(sourceId, extraction.content);
  }

  const buildFinding = async (position: Position): Promise<ReviewFinding> => {
    const extraction = contentBySourceId.get(position.sourceId);
    const askContent = extraction?.content;
    const tiers = tiersBySourceId.get(position.sourceId);
    const citations = extraction?.citations ?? [];

    const { verdict, rationale, matchedRef } = await gradePosition({
      position,
      tiers,
      askContent,
      fieldContentBySourceId,
      deps,
    });

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
        lastBlockId,
      }),
    };
  };

  // Deterministic rules resolve without an LLM call, so grade them all in
  // parallel. Tier-match positions each issue one targeted LLM compare; drain
  // them in bounded chunks so this single-doc review's fan-out stays capped the
  // same way `computeVerdictBatch` bounds its per-entity fan-out (see
  // POSITION_MATCH_CONCURRENCY). Findings are re-sorted by original index to
  // preserve the input `positions` order.
  const indexedFindings: { index: number; finding: ReviewFinding }[] = [];
  const tierMatchTasks: { index: number; position: Position }[] = [];

  await Promise.all(
    positions.map(async (position, index) => {
      if (gradedNeedsTierMatch(position)) {
        tierMatchTasks.push({ index, position });
        return;
      }
      indexedFindings.push({ index, finding: await buildFinding(position) });
    }),
  );

  for (
    let cursor = 0;
    cursor < tierMatchTasks.length;
    cursor += POSITION_MATCH_CONCURRENCY
  ) {
    const chunk = tierMatchTasks.slice(
      cursor,
      cursor + POSITION_MATCH_CONCURRENCY,
    );
    // oxlint-disable-next-line no-await-in-loop -- sequential chunk drain bounds the single-doc review's Promise.all fan-out of LLM compares
    await Promise.all(
      chunk.map(async ({ index, position }) => {
        indexedFindings.push({ index, finding: await buildFinding(position) });
      }),
    );
  }

  return indexedFindings
    .sort((a, b) => a.index - b.index)
    .map(({ finding }) => finding);
};
