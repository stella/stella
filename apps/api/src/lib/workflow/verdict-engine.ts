import { generateText, Output } from "ai";
import { Result } from "better-result";
import * as v from "valibot";

import type { ConditionNode } from "@stll/conditions";

import type { ScopedDb } from "@/api/db";
import type { JustificationContent } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type {
  PositionRule,
  ResolvedStandard,
} from "@/api/handlers/playbooks/positions";
import type { VerdictTier } from "@/api/handlers/playbooks/verdict-tiers";
import { getModelForRole } from "@/api/lib/ai-models";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import type {
  AIJustification,
  AIResult,
} from "@/api/lib/workflow/generate-batch-shared";
import { fetchInputFieldsForBatch } from "@/api/lib/workflow/generate-batch-shared";
import type { VerdictBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { evaluateGatingCondition } from "@/api/lib/workflow/utils";

// ── Presence of the ASK value ─────────────────────────
type PresenceState = "present" | "absent" | "missing";

// The per-rule graders and ASK flatteners below are exported so the single-doc
// ephemeral review handler (`handlers/playbooks/review-grade.ts`) grades an
// in-memory ASK value with the exact same rules `computeVerdictBatch` applies to
// persisted fields — one grading semantics across the files-table and
// single-file surfaces.

// "missing" = extraction never produced a usable value (no field, or an
// error/pending/unsupported placeholder); "absent" = it ran and produced an
// empty value; "present" = it produced a value.
export const askPresence = (
  content: FieldContent | undefined,
): PresenceState => {
  if (!content) {
    return "missing";
  }
  switch (content.type) {
    case "error":
    case "pending":
    case "unsupported":
      return "missing";
    case "text":
      return content.value.trim().length > 0 ? "present" : "absent";
    case "single-select":
      return content.value !== null && content.value.trim().length > 0
        ? "present"
        : "absent";
    case "multi-select":
      return content.value.length > 0 ? "present" : "absent";
    case "date":
      return content.value !== null && content.value.length > 0
        ? "present"
        : "absent";
    case "int":
    case "file":
    case "clip":
      return "present";
    default: {
      const exhaustive: never = content;
      void exhaustive;
      return "missing";
    }
  }
};

// Flatten the ASK field to the prose the positionMatch model compares against.
export const askText = (content: FieldContent | undefined): string | null => {
  if (!content) {
    return null;
  }
  switch (content.type) {
    case "text":
      return content.value;
    case "single-select":
      return content.value;
    case "multi-select":
      return content.value.length > 0 ? content.value.join(", ") : null;
    case "date":
      return content.value;
    case "int":
      return content.currency
        ? `${content.value} ${content.currency}`
        : String(content.value);
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

// ── Deterministic grading ─────────────────────────────
export const gradePresence = (
  expectation: "required" | "restricted",
  presence: PresenceState,
): VerdictTier => {
  if (presence === "missing") {
    return "missing";
  }
  if (expectation === "required") {
    return presence === "present" ? "compliant" : "deviation";
  }
  // restricted: the clause must NOT be present.
  return presence === "absent" ? "compliant" : "deviation";
};

export const gradePropertyConstraint = (
  condition: ConditionNode,
  askContent: FieldContent | undefined,
  fieldContentByPropertyId: ReadonlyMap<string, FieldContent>,
): VerdictTier => {
  // No extracted value to test the constraint against.
  if (askPresence(askContent) !== "present") {
    return "missing";
  }
  return evaluateGatingCondition(condition, fieldContentByPropertyId)
    ? "compliant"
    : "deviation";
};

// ── positionMatch (LLM) grading ───────────────────────
const VERDICT_SYSTEM_PROMPT =
  "You grade whether a value extracted from a contract meets a drafting " +
  "standard. You are given the preferred standard language, an ordered list " +
  "of acceptable fallback variants, and the extracted value. Decide: " +
  '"compliant" if the extracted value satisfies the intent of the preferred ' +
  'standard; "fallback" if it does not match the preferred standard but does ' +
  'satisfy one of the acceptable fallbacks; "deviation" if it satisfies ' +
  "neither. Judge by legal substance and effect, not wording. Give a short " +
  "one-sentence rationale.";

const buildVerdictUserMessage = ({
  preferred,
  fallbacks,
  askValue,
}: {
  preferred: string;
  fallbacks: string[];
  askValue: string;
}): string => {
  const lines = [
    "Preferred standard:",
    preferred.length > 0 ? preferred : "(none)",
  ];
  if (fallbacks.length > 0) {
    lines.push("", "Acceptable fallbacks (ranked, best first):");
    for (const [index, text] of fallbacks.entries()) {
      lines.push(`${index + 1}. ${text}`);
    }
  }
  lines.push("", "Extracted value:", askValue);
  return lines.join("\n");
};

const positionMatchSchema = v.strictObject({
  tier: v.picklist(["compliant", "fallback", "deviation"]),
  rationale: v.pipe(v.string(), v.maxLength(1000)),
});

type PositionMatchVerdict = {
  tier: VerdictTier;
  rationale: string;
  matched: "preferred" | "fallback" | "none";
};

export type GradePositionMatchArgs = {
  askValue: string;
  standard: ResolvedStandard;
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  orgAIConfig: OrgAIConfig | null | undefined;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
};

export const gradePositionMatch = async ({
  askValue,
  standard,
  abortSignal,
  organizationId,
  workspaceId,
  entityVersionId,
  propertyId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
}: GradePositionMatchArgs): Promise<
  Result<PositionMatchVerdict, WorkflowIntegrationError>
> => {
  const preferred = standard.preferred?.trim() ?? "";
  const fallbacks = [...(standard.fallbacks ?? [])]
    .sort((a, b) => a.rank - b.rank)
    .map((fallback) => fallback.text);

  // No standard language to compare against: a present value cannot be
  // verified, so flag it for review without spending an LLM call.
  if (preferred.length === 0 && fallbacks.length === 0) {
    return Result.ok({
      tier: "deviation",
      rationale: "No standard language was configured to compare against.",
      matched: "none",
    });
  }

  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "playbook.verdict",
    modelRole: "pdf",
    orgAIConfig: orgAIConfig ?? null,
    properties: {
      entity_version_id: entityVersionId,
      organization_id: organizationId,
      property_id: propertyId,
      workspace_id: workspaceId,
    },
    sessionId: entityVersionId,
    traceId: Bun.randomUUIDv7(),
  });

  return await Result.tryPromise({
    try: async (): Promise<PositionMatchVerdict> => {
      const result = await generateText({
        model: getModelForRole("pdf", orgAIConfig, {
          promptCachingEnabled,
          scopeKey: entityVersionId,
          organizationId,
          serviceTier,
        }),
        system: VERDICT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildVerdictUserMessage({
                  preferred,
                  fallbacks,
                  askValue,
                }),
              },
            ],
          },
        ],
        output: Output.object({
          schema: strictOutputSchema(positionMatchSchema),
        }),
        abortSignal,
        ...aiAnalytics.stepCallbacks,
      });

      const tier: VerdictTier = result.output.tier;
      let matched: PositionMatchVerdict["matched"] = "none";
      if (tier === "compliant") {
        matched = "preferred";
      } else if (tier === "fallback") {
        matched = "fallback";
      }
      return { tier, rationale: result.output.rationale, matched };
    },
    catch: (error) => {
      aiAnalytics.captureError(error);
      return new WorkflowIntegrationError({
        message: "Playbook verdict grading failed",
        cause: error,
      });
    },
  });
};

// ── Batch entry point ─────────────────────────────────
const buildVerdictResult = (
  propertyId: SafeId<"property">,
  tier: VerdictTier,
): AIResult => ({
  fieldId: createSafeId<"field">(),
  propertyId,
  content: { type: "single-select", version: 1, value: tier },
});

export type VerdictBatchOutput = {
  aiResults: AIResult[];
  aiJustifications: AIJustification[];
  // Verdicts gated out by an unmet dependency condition: their field is left
  // untouched, matching the extraction path's skip semantics.
  skippedPropertyIds: SafeId<"property">[];
  // positionMatch verdicts whose LLM call failed: the caller flips their field
  // to "error" so they stay re-runnable.
  erroredPropertyIds: SafeId<"property">[];
};

export type ComputeVerdictBatchArgs = {
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  scopedDb: ScopedDb;
  entityVersionId: SafeId<"entityVersion">;
  verdictProperties: VerdictBatchProperty[];
  // The batch's input property ids — the ASK (and any constraint-referenced)
  // properties whose values are read to grade each verdict.
  inputPropertyIds: SafeId<"property">[];
  orgAIConfig?: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
};

/**
 * Grade a batch of verdict properties for one entity version. Deterministic
 * rules (`presence`, `propertyConstraint`) are evaluated directly from the ASK
 * field value; `positionMatch` rules issue a targeted LLM compare against the
 * standard's preferred/fallback language and attach the rationale as a
 * justification. `extractOnly` never materializes a verdict, so it is skipped.
 */
export const computeVerdictBatch = async ({
  abortSignal,
  organizationId,
  workspaceId,
  scopedDb,
  entityVersionId,
  verdictProperties,
  inputPropertyIds,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
}: ComputeVerdictBatchArgs): Promise<VerdictBatchOutput> => {
  const inputFields = await fetchInputFieldsForBatch({
    entityVersionId,
    inputPropertyIds,
    scopedDb,
  });
  const fieldContentByPropertyId = new Map<string, FieldContent>(
    inputFields.map((field) => [field.propertyId, field.content]),
  );

  const aiResults: AIResult[] = [];
  const aiJustifications: AIJustification[] = [];
  const skippedPropertyIds: SafeId<"property">[] = [];
  const erroredPropertyIds: SafeId<"property">[] = [];

  type PositionMatchTask = {
    property: VerdictBatchProperty;
    askValue: string;
  };
  const positionMatchTasks: PositionMatchTask[] = [];

  for (const property of verdictProperties) {
    const conditionsMet = property.dependencies.every((dep) =>
      evaluateGatingCondition(dep.condition, fieldContentByPropertyId),
    );
    if (!conditionsMet) {
      skippedPropertyIds.push(property.id);
      continue;
    }

    const { tool } = property;
    const askContent = fieldContentByPropertyId.get(tool.askPropertyId);
    const rule: PositionRule = tool.rule;

    switch (rule.kind) {
      case "extractOnly":
        // No verdict is materialized for an extractOnly position; nothing to do.
        skippedPropertyIds.push(property.id);
        break;
      case "presence":
        aiResults.push(
          buildVerdictResult(
            property.id,
            gradePresence(rule.expectation, askPresence(askContent)),
          ),
        );
        break;
      case "propertyConstraint":
        aiResults.push(
          buildVerdictResult(
            property.id,
            gradePropertyConstraint(
              rule.condition,
              askContent,
              fieldContentByPropertyId,
            ),
          ),
        );
        break;
      case "positionMatch": {
        const askValue = askText(askContent);
        if (askValue === null || askValue.trim().length === 0) {
          aiResults.push(buildVerdictResult(property.id, "missing"));
          break;
        }
        positionMatchTasks.push({ property, askValue });
        break;
      }
      default: {
        const exhaustive: never = rule;
        void exhaustive;
        break;
      }
    }
  }

  await Promise.all(
    positionMatchTasks.map(async ({ property, askValue }) => {
      const graded = await gradePositionMatch({
        askValue,
        standard: property.tool.standard,
        abortSignal,
        organizationId,
        workspaceId,
        entityVersionId,
        propertyId: property.id,
        orgAIConfig,
        promptCachingEnabled,
        serviceTier,
      });
      if (Result.isError(graded)) {
        erroredPropertyIds.push(property.id);
        return;
      }
      const { tier, rationale, matched } = graded.value;
      const fieldId = createSafeId<"field">();
      aiResults.push({
        fieldId,
        propertyId: property.id,
        content: { type: "single-select", version: 1, value: tier },
      });
      const content: JustificationContent = {
        version: 1,
        blocks: [{ kind: "playbook-verdict", rationale, matched }],
      };
      aiJustifications.push({
        fieldId,
        justificationId: createSafeId<"justification">(),
        content,
        fileFieldIds: [],
      });
    }),
  );

  return {
    aiResults,
    aiJustifications,
    skippedPropertyIds,
    erroredPropertyIds,
  };
};
