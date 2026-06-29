import { panic, Result } from "better-result";

import type { FieldContent } from "@/api/db/schema-validators";
import type {
  Position,
  PositionSeverity,
  ResolvedStandard,
} from "@/api/handlers/playbooks/positions";
import type {
  AskExtraction,
  DocxFolioCitation,
} from "@/api/handlers/playbooks/review-extract";
import type { VerdictTier } from "@/api/handlers/playbooks/verdict-tiers";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-models";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  askPresence,
  askText,
  gradePositionMatch,
  gradePresence,
  gradePropertyConstraint,
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
  // null for `extractOnly` positions (a value column with no verdict).
  verdict: VerdictTier | null;
  extracted: { value: string; text: string } | null;
  rationale: string | null;
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
};

export type BuildFindingsArgs = AiGradingDeps & {
  positions: readonly Position[];
  contentBySourceId: ReadonlyMap<string, AskExtraction>;
  standardBySourceId: ReadonlyMap<string, ResolvedStandard>;
  lastBlockId: string | null;
};

type GradedVerdict = {
  verdict: VerdictTier | null;
  rationale: string | null;
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
// resolved preferred language to insert. A located deviating clause (primary
// citation) is replaced; a missing clause with no citation is appended after the
// last block. Null when there is no anchor or no preferred text.
const buildFix = ({
  verdict,
  citations,
  preferred,
  lastBlockId,
}: {
  verdict: VerdictTier | null;
  citations: readonly DocxFolioCitation[];
  preferred: string | undefined;
  lastBlockId: string | null;
}): ReviewFix | null => {
  if (verdict !== "deviation" && verdict !== "missing") {
    return null;
  }
  const text = preferred?.trim();
  if (!text || text.length === 0) {
    return null;
  }
  const primaryBlockId = citations.at(0)?.blockId;
  if (primaryBlockId !== undefined) {
    return { kind: "replaceBlock", blockId: primaryBlockId, text };
  }
  if (lastBlockId !== null) {
    return { kind: "insertAfterBlock", blockId: lastBlockId, text };
  }
  return null;
};

const gradePosition = async ({
  position,
  askContent,
  fieldContentBySourceId,
  standard,
  deps,
}: {
  position: Position;
  askContent: FieldContent | undefined;
  fieldContentBySourceId: ReadonlyMap<string, FieldContent>;
  standard: ResolvedStandard;
  deps: AiGradingDeps;
}): Promise<GradedVerdict> => {
  const { rule } = position;
  switch (rule.kind) {
    case "extractOnly":
      return { verdict: null, rationale: null };
    case "presence":
      return {
        verdict: gradePresence(rule.expectation, askPresence(askContent)),
        rationale: null,
      };
    case "propertyConstraint":
      // The condition references the position's own value via a `property`
      // operand whose id is the position sourceId, so it resolves against the
      // sourceId-keyed content map directly (no materialized-property remap).
      return {
        verdict: gradePropertyConstraint(
          rule.condition,
          askContent,
          fieldContentBySourceId,
        ),
        rationale: null,
      };
    case "positionMatch": {
      const askValue = askText(askContent);
      if (askValue === null || askValue.trim().length === 0) {
        return { verdict: "missing", rationale: null };
      }
      const graded = await gradePositionMatch({
        askValue,
        standard,
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
      });
      if (Result.isError(graded)) {
        // A failed compare must not silently pass: flag it for human review,
        // mirroring the engine's "no standard language" deviation fallback.
        return {
          verdict: "deviation",
          rationale:
            "Automated comparison against the standard could not be completed.",
        };
      }
      return { verdict: graded.value.tier, rationale: graded.value.rationale };
    }
    default: {
      const exhaustive: never = rule;
      void exhaustive;
      return panic("Unhandled position rule kind");
    }
  }
};

export const buildFindings = async ({
  positions,
  contentBySourceId,
  standardBySourceId,
  lastBlockId,
  ...deps
}: BuildFindingsArgs): Promise<ReviewFinding[]> => {
  const fieldContentBySourceId = new Map<string, FieldContent>();
  for (const [sourceId, extraction] of contentBySourceId) {
    fieldContentBySourceId.set(sourceId, extraction.content);
  }

  // Grade in parallel: deterministic rules resolve immediately; positionMatch
  // rules each issue one targeted LLM compare, matching the batch engine's
  // parallel positionMatch fan-out.
  return await Promise.all(
    positions.map(async (position): Promise<ReviewFinding> => {
      const extraction = contentBySourceId.get(position.sourceId);
      const askContent = extraction?.content;
      const standard = standardBySourceId.get(position.sourceId) ?? {};
      const citations = extraction?.citations ?? [];

      const { verdict, rationale } = await gradePosition({
        position,
        askContent,
        fieldContentBySourceId,
        standard,
        deps,
      });

      return {
        positionId: position.sourceId,
        issue: position.issue,
        severity: position.severity,
        verdict,
        extracted: extractedFromContent(askContent),
        rationale,
        citations,
        fix: buildFix({
          verdict,
          citations,
          preferred: standard.preferred,
          lastBlockId,
        }),
      };
    }),
  );
};
