import { Result } from "better-result";
import * as v from "valibot";

import type { ConditionNode } from "@stll/conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import type { JustificationContent, VerdictMatchedRef } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type {
  PositionRule,
  ResolvedTiers,
} from "@/api/handlers/playbooks/positions";
import type { VerdictTier } from "@/api/handlers/playbooks/verdict-tiers";
import { resolveCaching } from "@/api/lib/ai-config";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
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

// ── Tier-match (LLM) grading ──────────────────────────
export const TIER_MATCH_SYSTEM_PROMPT =
  "You grade whether a value extracted from a contract meets a tiered drafting " +
  "standard authored by a lawyer for one issue. You are given: numbered " +
  "acceptable rules the value must satisfy, the ideal (preferred) language, " +
  "ranked fallback options, numbered not-acceptable (red-line) rules, and the " +
  'extracted value. Decide exactly one tier. Choose "compliant" when the ' +
  "value satisfies the acceptable rules or the intent of the ideal language. " +
  'Choose "fallback" when it does not meet the ideal but matches one of the ' +
  'ranked fallback options; set matched to { kind: "fallback", rank } with ' +
  'the [rank N] of the option it matched. Choose "deviation" when the value ' +
  'violates a red-line rule; set matched to { kind: "redLine", rank } with ' +
  'the [rank N] of the violated rule. Also choose "deviation" when the value ' +
  "satisfies none of the tiers, and omit matched. Judge by legal substance and " +
  "effect, not wording. Give a short one-sentence rationale.";

export const buildTierMatchUserMessage = ({
  tiers,
  askValue,
}: {
  tiers: ResolvedTiers;
  askValue: string;
}): string => {
  const lines: string[] = [];

  lines.push("Acceptable rules:");
  if (tiers.acceptableRules.length > 0) {
    for (const [index, rule] of tiers.acceptableRules.entries()) {
      lines.push(`${index + 1}. ${rule.text}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("", "Ideal language:", tiers.ideal ?? "(none)");

  lines.push("", "Fallback options (ranked, best first):");
  if (tiers.fallbacks.length > 0) {
    for (const fallback of tiers.fallbacks) {
      const label = fallback.label ? ` (${fallback.label})` : "";
      lines.push(`[rank ${fallback.rank}]${label} ${fallback.text}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("", "Not-acceptable rules (red lines):");
  if (tiers.notAcceptableRules.length > 0) {
    for (const [index, rule] of tiers.notAcceptableRules.entries()) {
      lines.push(`[rank ${index}] ${rule.text}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("", "Extracted value:", askValue);
  return lines.join("\n");
};

const tierMatchSchema = v.strictObject({
  tier: v.picklist(["compliant", "fallback", "deviation"]),
  rationale: v.pipe(v.string(), v.maxLength(1000)),
  matched: v.optional(
    v.strictObject({
      kind: v.picklist(["fallback", "redLine"]),
      rank: v.number(),
    }),
  ),
});

type TierMatchOutput = v.InferOutput<typeof tierMatchSchema>;

type TierMatchVerdict = {
  tier: VerdictTier;
  rationale: string;
  matchedRef?: VerdictMatchedRef;
};

// Empty resolved tiers: no ideal, no fallbacks, no acceptable/red-line rules.
// `ideal` is optional, so its absence is the empty state.
const EMPTY_RESOLVED_TIERS: ResolvedTiers = {
  fallbacks: [],
  acceptableRules: [],
  notAcceptableRules: [],
};

// Pre-v2 materialized verdict rows persisted `{standard}` and were lifted
// without a resolved `tiers` snapshot; the positions migration only rewrote
// `playbook_definitions.positions`, never `properties.tool`. Such a row still
// reaches the grader with `tiers` absent at runtime even though
// `PlaybookVerdictTool` types it as always present, so read it through a widened
// view (optional `tiers`) and default to empty tiers. `gradeTierMatch`'s
// `tiersHaveContent` guard then grades it deterministically to `deviation` with
// the "no criteria configured" rationale (no LLM call) instead of dereferencing
// undefined and throwing. Mirrors the same default in `review-grade.ts`.
const resolveVerdictTiers = ({
  tiers,
}: {
  tiers?: ResolvedTiers;
}): ResolvedTiers => tiers ?? EMPTY_RESOLVED_TIERS;

// A graded position with no authored tier content and no deterministic check is
// rejected at validation, but a v1-lifted row can carry it. Force `deviation`
// rather than compare an extracted value against nothing.
const tiersHaveContent = (tiers: ResolvedTiers): boolean =>
  tiers.ideal !== undefined ||
  tiers.fallbacks.length > 0 ||
  tiers.acceptableRules.length > 0 ||
  tiers.notAcceptableRules.length > 0;

// Resolve the grader's ranked `matched` into a stable reference so consumers
// never re-index the resolved tiers. An out-of-bounds rank (model error) drops
// the reference rather than fabricating one.
export const resolveMatchedRef = (
  matched: TierMatchOutput["matched"],
  tiers: ResolvedTiers,
): VerdictMatchedRef | undefined => {
  if (matched === undefined) {
    return undefined;
  }
  if (matched.kind === "fallback") {
    const entry = tiers.fallbacks.at(matched.rank);
    if (!entry) {
      return undefined;
    }
    return {
      kind: "fallback",
      ...(entry.label === undefined ? {} : { label: entry.label }),
      text: entry.text,
    };
  }
  const rule = tiers.notAcceptableRules.at(matched.rank);
  if (!rule) {
    return undefined;
  }
  return { kind: "redLine", ruleId: rule.id, text: rule.text };
};

export type GradeTierMatchArgs = {
  askValue: string;
  tiers: ResolvedTiers;
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  orgAIConfig: OrgAIConfig | null | undefined;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering?: AIUsageMetering | undefined;
};

export const gradeTierMatch = async ({
  askValue,
  tiers,
  abortSignal,
  organizationId,
  workspaceId,
  entityVersionId,
  propertyId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
}: GradeTierMatchArgs): Promise<
  Result<TierMatchVerdict, WorkflowIntegrationError>
> => {
  // Nothing authored to compare against: a present value cannot be verified, so
  // flag it for review without spending an LLM call (defense in depth —
  // validation already rejects this shape for new saves).
  if (!tiersHaveContent(tiers)) {
    return Result.ok({
      tier: "deviation",
      rationale:
        "No acceptable, fallback, or red-line criteria were configured to compare against.",
    });
  }

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
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
    ...(usageMetering ? { usageMetering } : {}),
  });

  return await Result.tryPromise({
    try: async (): Promise<TierMatchVerdict> => {
      const result = await generateTanStackObjectForRole({
        role: "pdf",
        orgAIConfig,
        organizationId,
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled,
          role: "pdf",
          scopeKey: entityVersionId,
        }),
        serviceTier,
        system: TIER_MATCH_SYSTEM_PROMPT,
        prompt: buildTierMatchUserMessage({ tiers, askValue }),
        abortSignal,
        outputSchema: tierMatchSchema,
      });

      const tier: VerdictTier = result.tier;
      const matchedRef = resolveMatchedRef(result.matched, tiers);
      return {
        tier,
        rationale: result.rationale,
        ...(matchedRef === undefined ? {} : { matchedRef }),
      };
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
  usageMetering?: AIUsageMetering | undefined;
};

// Each positionMatch verdict issues one LLM compare. Up to
// MAX_CONCURRENT_ENTITIES entities grade in parallel upstream, so bound the
// per-entity fan-out here: a large playbook (many positions per document) must
// not burst an unbounded number of external calls at once and trip provider
// rate limits or timeouts.
export const POSITION_MATCH_CONCURRENCY = 4;

/**
 * Grade a batch of verdict properties for one entity version. Deterministic
 * rules (`presence`, `propertyConstraint`) are evaluated directly from the ASK
 * field value; `positionMatch` rules issue a targeted LLM tier-match against the
 * resolved tiers (ideal, fallbacks, acceptable/red-line rules) and attach the
 * rationale plus resolved `matchedRef` as a justification. `extractOnly` never
 * materializes a verdict, so it is skipped.
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
  usageMetering,
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

  // Drain the position-match compares in bounded chunks so the per-entity LLM
  // fan-out stays capped (see POSITION_MATCH_CONCURRENCY).
  for (
    let index = 0;
    index < positionMatchTasks.length;
    index += POSITION_MATCH_CONCURRENCY
  ) {
    const chunk = positionMatchTasks.slice(
      index,
      index + POSITION_MATCH_CONCURRENCY,
    );
    // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- sequential chunk drain bounds the per-entity Promise.all fan-out of LLM compares
    await Promise.all(
      chunk.map(async ({ property, askValue }) => {
        const graded = await gradeTierMatch({
          askValue,
          tiers: resolveVerdictTiers(property.tool),
          abortSignal,
          organizationId,
          workspaceId,
          entityVersionId,
          propertyId: property.id,
          orgAIConfig,
          promptCachingEnabled,
          serviceTier,
          usageMetering,
        });
        if (Result.isError(graded)) {
          erroredPropertyIds.push(property.id);
          return;
        }
        const { tier, rationale, matchedRef } = graded.value;
        const fieldId = createSafeId<"field">();
        aiResults.push({
          fieldId,
          propertyId: property.id,
          content: { type: "single-select", version: 1, value: tier },
        });
        const content: JustificationContent = {
          version: 1,
          blocks: [
            {
              kind: "playbook-verdict",
              rationale,
              ...(matchedRef === undefined ? {} : { matchedRef }),
            },
          ],
        };
        aiJustifications.push({
          fieldId,
          justificationId: createSafeId<"justification">(),
          content,
          fileFieldIds: [],
        });
      }),
    );
  }

  return {
    aiResults,
    aiJustifications,
    skippedPropertyIds,
    erroredPropertyIds,
  };
};
