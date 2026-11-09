import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import type { AiCellSettlement } from "@stll/api-contract";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import type { ConditionNode } from "@stll/conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import { justifications } from "@/api/db/schema";
import type { JustificationContent, VerdictMatchedRef } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { resolveCaching } from "@/api/lib/ai-config";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import {
  type AIUsageMetering,
  createTanStackAIAnalyticsCallbacks,
} from "@/api/lib/analytics/tanstack-ai";
import { arrayOrEmpty } from "@/api/lib/array";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { recordText } from "@/api/lib/fields/record-text";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { UNTRUSTED_DOCUMENT_INSTRUCTION } from "@/api/lib/workflow/ai-prompts";
import {
  buildPassageListMessage,
  sharePassages,
  verifiedPassageTexts,
} from "@/api/lib/workflow/cited-passages";
import type {
  AIJustification,
  AIResult,
  InputFieldRow,
} from "@/api/lib/workflow/generate-batch-shared";
import { fetchInputFieldsForBatch } from "@/api/lib/workflow/generate-batch-shared";
import type { VerdictBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type {
  PositionRule,
  ResolvedTiers,
} from "@/api/lib/workflow/playbook-positions";
import { evaluateGatingCondition } from "@/api/lib/workflow/utils";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

// ── Presence of the ASK value ─────────────────────────
type PresenceState = "present" | "absent" | "missing";

// The per-rule graders and ASK flatteners below are exported so the single-doc
// ephemeral review (`lib/document-review/review-grade.ts`) grades an
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
    case "money":
    case "person":
    case "file":
    case "clip":
      return "present";
    // A refused tool input never reached its source: no answer to grade.
    case "record":
      if (content.state.status === "input-needs-review") {
        return "missing";
      }
      return recordText(content.state).length > 0 ? "present" : "absent";
    default: {
      content satisfies never;
      return panic(`Unhandled content: ${String(content)}`);
    }
  }
};

type AskCell = {
  content: FieldContent;
  aiSettlement: AiCellSettlement | null;
};

/**
 * What an ASK cell can support. `unfinished` means it says nothing about the
 * document, because extraction failed, is unfinished or could not read the
 * file, so it must never grade as a missing clause. `refused` means the
 * document was read but the model declined this one question: it says nothing
 * about the document either, but nothing about the rest of the review.
 * `cutUnanswered` means no answer turned up in a document that was only partly
 * read. A model's "not stated" answer is stored as `unsupported` too, and only
 * its settlement tells these apart. No cell at all stays gradable: a failed
 * extraction always leaves a cell.
 */
const askCellStanding = (
  cell: AskCell | undefined,
): "gradable" | "unfinished" | "refused" | "cutUnanswered" => {
  if (cell === undefined) {
    return "gradable";
  }
  if (cell.content.type !== "unsupported") {
    return askPresence(cell.content) === "missing" ? "unfinished" : "gradable";
  }
  switch (cell.aiSettlement?.type) {
    case "notStated":
      return "gradable";
    case "notFoundInCutDocument":
      return "cutUnanswered";
    case "refused":
      return "refused";
    case "value":
    case "failed":
    case undefined:
      return "unfinished";
    default:
      cell.aiSettlement satisfies never;
      return panic("Unhandled AI cell settlement");
  }
};

/** Why a position with no answer in a partly read document needs a person. */
export const CUT_DOCUMENT_RATIONALE =
  "No answer was found, but this document was too long to read in full, so " +
  "the answer may be in the part that was withheld.";

/** The ASK value a finding records: the raw value and the prose rendering of
 *  it. Null when the cell holds no answer (or a placeholder). */
export type ExtractedAskValue = { value: string; text: string };

// Flatten the ASK field into the value a finding carries. Exported so the
// files-table path and the single-doc review record the same extracted value
// for the same cell content.
export const extractedFromContent = (
  content: FieldContent | undefined,
): ExtractedAskValue | null => {
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
    case "money": {
      const value = String(content.amountCents);
      return { value, text: `${value} ${content.currency}` };
    }
    case "person":
      return { value: content.name, text: content.name };
    case "record": {
      const text = recordText(content.state);
      return text.length > 0 ? { value: text, text } : null;
    }
    case "file":
    case "clip":
    case "error":
    case "pending":
    case "unsupported":
      return null;
    default: {
      content satisfies never;
      return panic(`Unhandled content: ${String(content)}`);
    }
  }
};

const CITED_PASSAGE_SEPARATOR = "\n\n";

/**
 * A tier-match answer is a summary in the model's words, and the verified
 * passages it cites are the document's own. The finding records those passages
 * as the text the value was read from, so its evidence stays the same across
 * runs that word the summary differently.
 */
export const extractedFromCitedClause = (
  content: FieldContent | undefined,
  passages: readonly string[],
): ExtractedAskValue | null => {
  const extracted = extractedFromContent(content);
  if (extracted === null || passages.length === 0) {
    return extracted;
  }
  return {
    value: extracted.value,
    text: passages.join(CITED_PASSAGE_SEPARATOR),
  };
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
    case "money":
      return `${content.amountCents} ${content.currency}`;
    case "person":
      return content.name;
    case "record": {
      const text = recordText(content.state);
      return text.length > 0 ? text : null;
    }
    case "file":
    case "clip":
    case "error":
    case "pending":
    case "unsupported":
      return null;
    default: {
      content satisfies never;
      return panic(`Unhandled content: ${String(content)}`);
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
  'satisfies none of the tiers, and omit matched. Choose "not-applicable" only ' +
  "when the issue does not pertain to this contract at all, meaning the extracted " +
  "value shows the document is a different kind of agreement or the topic is " +
  "structurally out of scope, so it counts neither for nor against compliance; " +
  "omit matched. Do not use not-applicable merely because a clause is absent " +
  '(that is a "missing" gap). Judge by legal substance and effect, not wording. ' +
  "Give a short one-sentence rationale. Some values come with contract " +
  "passages, listed by label: the passages are the contract's exact wording and " +
  "the value is only a summary of them. When a value has passages, grade what " +
  "the passages say, so a term they state counts even when the summary leaves it " +
  `out. ${UNTRUSTED_DOCUMENT_INSTRUCTION}`;

export const buildTierMatchUserMessage = ({
  tiers,
  askValue,
  passageLabels,
}: {
  tiers: ResolvedTiers;
  askValue: string;
  passageLabels: readonly string[];
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

  lines.push(
    "",
    "Extracted value:",
    sanitizeForPrompt(untrustedText(askValue)),
  );
  if (passageLabels.length > 0) {
    lines.push("", `Contract passages: ${passageLabels.join(", ")}`);
  }
  return lines.join("\n");
};

/** Read by the structured-output role contract test. @public */
export const tierMatchSchema = v.strictObject({
  tier: v.picklist(["compliant", "fallback", "deviation", "not-applicable"]),
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

type TierMatchPromptItem = Pick<
  GradeTierMatchArgs,
  "askValue" | "tiers" | "passages"
>;

export const buildTierMatchPrompt = (
  items: readonly TierMatchPromptItem[],
  numbering: "numbered" | "unnumbered",
): string => {
  const { unique, labeled } = sharePassages(items);
  const parts = labeled.map(({ item: { askValue, tiers }, labels }, index) => {
    const message = buildTierMatchUserMessage({
      tiers,
      askValue,
      passageLabels: labels,
    });
    return numbering === "numbered"
      ? `Item ${String(index + 1)}:\n${message}`
      : message;
  });
  return [
    ...(unique.length > 0 ? [buildPassageListMessage(unique)] : []),
    ...parts,
  ].join("\n\n");
};

export type GradeTierMatchArgs = {
  askValue: string;
  tiers: ResolvedTiers;
  /** Exact wording of the blocks the answer cites; empty when it cites none. */
  passages: readonly string[];
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  admission: ModelDispatchAdmission;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  orgAIConfig: OrgAIConfig | null | undefined;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering?: AIUsageMetering | undefined;
};

export const gradeTierMatch = async ({
  askValue,
  tiers,
  passages,
  abortSignal,
  organizationId,
  admission,
  workspaceId,
  entityVersionId,
  propertyId,
  orgAIConfig,
  managedAIResidency,
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
    dataClass: "customer",
    feature: "playbook.verdict",
    modelTask: "pdf",
    orgAIConfig: orgAIConfig ?? null,
    modelTier: admission.modelTier,
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
      const result = await generateTanStackObjectForTask({
        userId: admission.userId,
        dataClass: "customer",
        task: "pdf",
        orgAIConfig,
        managedAIResidency,
        organizationId,
        admission,
        tenantWorkspaceIds: [workspaceId],
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled,
          task: "pdf",
          scopeKey: entityVersionId,
        }),
        serviceTier,
        system: TIER_MATCH_SYSTEM_PROMPT,
        prompt: buildTierMatchPrompt(
          [{ askValue, tiers, passages }],
          "unnumbered",
        ),
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

// ── Tier-match (LLM) grading, several positions per call ──
/** How many positions one grading call carries. Enough to cut a playbook's
 *  call count several-fold, few enough that the model keeps each item apart. */
export const TIER_MATCH_BATCH_SIZE = 8;

const TIER_MATCH_BATCH_SYSTEM_PROMPT =
  `${TIER_MATCH_SYSTEM_PROMPT} ` +
  "The input lists several independent items, each numbered and carrying its " +
  "own rules, ideal language, fallback options, red lines, and extracted value; " +
  "passages listed before the items are shared, and an item uses only the ones " +
  "it names. " +
  "Grade every item on its own, keep its item number, and return exactly one " +
  "verdict per item.";

/** Read by the structured-output role contract test. @public */
export const tierMatchBatchSchema = v.strictObject({
  verdicts: v.array(
    v.strictObject({
      item: v.pipe(v.number(), v.integer(), v.minValue(1)),
      ...tierMatchSchema.entries,
    }),
  ),
});

export type TierMatchItem = {
  /** The caller's handle for the position; verdicts come back keyed by it. */
  key: string;
  askValue: string;
  tiers: ResolvedTiers;
  passages: readonly string[];
};

export type GradeTierMatchesArgs = Omit<
  GradeTierMatchArgs,
  "askValue" | "tiers" | "passages" | "propertyId"
> & {
  items: readonly TierMatchItem[];
};

const NO_CRITERIA_VERDICT: TierMatchVerdict = {
  tier: "deviation",
  rationale:
    "No acceptable, fallback, or red-line criteria were configured to compare against.",
};

/**
 * Grade up to {@link TIER_MATCH_BATCH_SIZE} positions in one model call. Each
 * item is numbered in the prompt and the model answers per number; an item
 * the model leaves out is absent from the result, so the caller decides what
 * an ungraded position means rather than this function inventing a tier.
 * Items with nothing authored to compare against are decided here without a
 * call, exactly as {@link gradeTierMatch} does.
 */
export const gradeTierMatches = async ({
  items,
  abortSignal,
  organizationId,
  admission,
  workspaceId,
  entityVersionId,
  orgAIConfig,
  managedAIResidency,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
}: GradeTierMatchesArgs): Promise<
  Result<ReadonlyMap<string, TierMatchVerdict>, WorkflowIntegrationError>
> => {
  const verdicts = new Map<string, TierMatchVerdict>();
  const pending: TierMatchItem[] = [];
  for (const item of items) {
    if (tiersHaveContent(item.tiers)) {
      pending.push(item);
    } else {
      verdicts.set(item.key, NO_CRITERIA_VERDICT);
    }
  }
  if (pending.length === 0) {
    return Result.ok(verdicts);
  }

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    feature: "playbook.verdict",
    modelTask: "pdf",
    orgAIConfig: orgAIConfig ?? null,
    modelTier: admission.modelTier,
    properties: {
      entity_version_id: entityVersionId,
      item_count: pending.length,
      organization_id: organizationId,
      workspace_id: workspaceId,
    },
    sessionId: entityVersionId,
    traceId: Bun.randomUUIDv7(),
    ...(usageMetering ? { usageMetering } : {}),
  });

  return await Result.tryPromise({
    try: async (): Promise<ReadonlyMap<string, TierMatchVerdict>> => {
      const result = await generateTanStackObjectForTask({
        userId: admission.userId,
        dataClass: "customer",
        task: "pdf",
        orgAIConfig,
        managedAIResidency,
        organizationId,
        admission,
        tenantWorkspaceIds: [workspaceId],
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled,
          task: "pdf",
          scopeKey: entityVersionId,
        }),
        serviceTier,
        system: TIER_MATCH_BATCH_SYSTEM_PROMPT,
        prompt: buildTierMatchPrompt(pending, "numbered"),
        abortSignal,
        outputSchema: tierMatchBatchSchema,
      });

      for (const verdict of result.verdicts) {
        const item = pending.at(verdict.item - 1);
        // A number outside the batch, or a second answer for one item, is
        // model error: the first answer stands, the stray is dropped.
        if (item === undefined || verdicts.has(item.key)) {
          continue;
        }
        const matchedRef = resolveMatchedRef(verdict.matched, item.tiers);
        verdicts.set(item.key, {
          tier: verdict.tier,
          rationale: verdict.rationale,
          ...(matchedRef === undefined ? {} : { matchedRef }),
        });
      }
      return verdicts;
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
type FetchCitedPassagesOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  fieldIds: SafeId<"field">[];
};

/** One justification per field, so the row count is bounded by `fieldIds`. */
const fetchCitedPassagesByFieldId = async ({
  scopedDb,
  workspaceId,
  fieldIds,
}: FetchCitedPassagesOptions): Promise<ReadonlyMap<string, string[]>> => {
  if (fieldIds.length === 0) {
    return new Map();
  }
  const rows = await scopedDb((tx) =>
    tx
      .select({
        fieldId: justifications.fieldId,
        content: justifications.content,
      })
      .from(justifications)
      .where(
        and(
          eq(justifications.workspaceId, workspaceId),
          inArray(justifications.fieldId, fieldIds),
        ),
      ),
  );
  return new Map(
    rows.map((row) => [row.fieldId, verifiedPassageTexts(row.content)]),
  );
};

const buildVerdictResult = (
  propertyId: SafeId<"property">,
  tier: VerdictTier,
): AIResult => ({
  fieldId: createSafeId<"field">(),
  propertyId,
  content: { type: "single-select", version: 1, value: tier },
});

/**
 * One graded position, as the durable finding row needs it.
 *
 * The verdict cell keeps only the tier; a finding keeps the reasoning and the
 * value it was reached from. Returning both from one grading pass is what lets
 * the files-table path record a finding without grading anything twice.
 */
export type GradedVerdict = {
  propertyId: SafeId<"property">;
  verdict: VerdictTier;
  /** Present only for a tier-match verdict; deterministic rules explain
   *  themselves from the rule and the value. */
  rationale: string | null;
  matchedRef?: VerdictMatchedRef;
  extracted: ExtractedAskValue | null;
};

/**
 * A position whose document was read but which this batch could not grade: the
 * model declined its question, or the tier-match call failed. Its cell settles
 * as failed, so it stays re-runnable; the files-table run records it the way
 * the review worker does, as a finding flagged for a person.
 */
export type UngradedVerdict = {
  propertyId: SafeId<"property">;
  extracted: ExtractedAskValue | null;
};

export type VerdictBatchOutput = {
  aiResults: AIResult[];
  aiJustifications: AIJustification[];
  /** Every verdict this batch actually decided, in grading order. Excludes the
   *  ungraded, skipped and errored ones below, which decided nothing. */
  gradedVerdicts: GradedVerdict[];
  ungradedVerdicts: UngradedVerdict[];
  // Verdicts gated out by an unmet dependency condition: their field is left
  // untouched, matching the extraction path's skip semantics.
  skippedPropertyIds: SafeId<"property">[];
  // Verdicts whose ASK extraction never finished: there is no answer to grade,
  // so the caller flips their field to "error" and they stay re-runnable.
  erroredPropertyIds: SafeId<"property">[];
  /** One disposition for every verdict cell claimed by this batch. */
  settlements: ReadonlyMap<
    SafeId<"property">,
    "answered" | "notStated" | "failedTransient"
  >;
};

export type ComputeVerdictBatchArgs = {
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  admission: ModelDispatchAdmission;
  workspaceId: SafeId<"workspace">;
  scopedDb: ScopedDb;
  entityVersionId: SafeId<"entityVersion">;
  verdictProperties: VerdictBatchProperty[];
  // The batch's input property ids — the ASK (and any constraint-referenced)
  // properties whose values are read to grade each verdict.
  inputPropertyIds: SafeId<"property">[];
  orgAIConfig?: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering?: AIUsageMetering | undefined;
  /** External model-dispatch boundary; supplied by focused tests. */
  gradeTierMatch?: typeof gradeTierMatch | undefined;
};

// The same flag the review panel raises: a deviation a person must look at, with
// the reason in its rationale.
const cutDocumentFlag = (propertyId: SafeId<"property">) => {
  const result = buildVerdictResult(propertyId, "deviation");
  const justification: AIJustification = {
    fieldId: result.fieldId,
    justificationId: createSafeId<"justification">(),
    content: {
      version: 1,
      blocks: [{ kind: "playbook-verdict", rationale: CUT_DOCUMENT_RATIONALE }],
    },
    fileFieldIds: [],
  };
  const graded: GradedVerdict = {
    propertyId,
    verdict: "deviation",
    rationale: CUT_DOCUMENT_RATIONALE,
    extracted: null,
  };
  return { result, justification, graded };
};

// The cell, the finding record and the rationale of one graded tier match.
const tierMatchRecords = ({
  propertyId,
  graded: { tier, rationale, matchedRef },
  extracted,
}: {
  propertyId: SafeId<"property">;
  graded: TierMatchVerdict;
  extracted: GradedVerdict["extracted"];
}) => {
  const fieldId = createSafeId<"field">();
  const result: AIResult = {
    fieldId,
    propertyId,
    content: { type: "single-select", version: 1, value: tier },
  };
  const ref = matchedRef === undefined ? {} : { matchedRef };
  const graded: GradedVerdict = {
    propertyId,
    verdict: tier,
    rationale,
    ...ref,
    extracted,
  };
  const content: JustificationContent = {
    version: 1,
    blocks: [{ kind: "playbook-verdict", rationale, ...ref }],
  };
  const justification: AIJustification = {
    fieldId,
    justificationId: createSafeId<"justification">(),
    content,
    fileFieldIds: [],
  };
  return { result, graded, justification };
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
  admission,
  workspaceId,
  scopedDb,
  entityVersionId,
  verdictProperties,
  inputPropertyIds,
  orgAIConfig,
  managedAIResidency,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  gradeTierMatch: gradeTierMatchForVerdict = gradeTierMatch,
}: ComputeVerdictBatchArgs): Promise<VerdictBatchOutput> => {
  const inputFields = await fetchInputFieldsForBatch({
    entityVersionId,
    inputPropertyIds,
    scopedDb,
  });
  const fieldContentByPropertyId = new Map<string, FieldContent>(
    inputFields.map((field) => [field.propertyId, field.content]),
  );
  const inputFieldByPropertyId = new Map<string, InputFieldRow>(
    inputFields.map((field) => [field.propertyId, field]),
  );

  const aiResults: AIResult[] = [];
  const aiJustifications: AIJustification[] = [];
  const gradedVerdicts: GradedVerdict[] = [];
  const ungradedVerdicts: UngradedVerdict[] = [];
  const skippedPropertyIds: SafeId<"property">[] = [];
  const erroredPropertyIds: SafeId<"property">[] = [];
  const settlements = new Map<
    SafeId<"property">,
    "answered" | "notStated" | "failedTransient"
  >();

  // Every decided verdict lands in both places at once: the cell the table
  // renders, and the record a finding is written from.
  const recordDeterministic = (
    property: VerdictBatchProperty,
    verdict: VerdictTier,
  ): void => {
    aiResults.push(buildVerdictResult(property.id, verdict));
    gradedVerdicts.push({
      propertyId: property.id,
      verdict,
      rationale: null,
      extracted: extractedFromContent(
        fieldContentByPropertyId.get(property.tool.askPropertyId),
      ),
    });
    settlements.set(property.id, "answered");
  };

  type PositionMatchTask = {
    property: VerdictBatchProperty;
    askValue: string;
    askFieldId: SafeId<"field"> | undefined;
  };
  const positionMatchTasks: PositionMatchTask[] = [];

  for (const property of verdictProperties) {
    const conditionsMet = property.dependencies.every((dep) =>
      evaluateGatingCondition(dep.condition, fieldContentByPropertyId),
    );
    if (!conditionsMet) {
      skippedPropertyIds.push(property.id);
      settlements.set(property.id, "notStated");
      continue;
    }

    const { tool } = property;
    const askContent = fieldContentByPropertyId.get(tool.askPropertyId);
    const rule: PositionRule = tool.rule;

    const standing = askCellStanding(
      inputFieldByPropertyId.get(tool.askPropertyId),
    );
    if (rule.kind !== "extractOnly" && standing === "unfinished") {
      erroredPropertyIds.push(property.id);
      settlements.set(property.id, "failedTransient");
      continue;
    }
    if (rule.kind !== "extractOnly" && standing === "refused") {
      ungradedVerdicts.push({ propertyId: property.id, extracted: null });
      settlements.set(property.id, "failedTransient");
      continue;
    }
    if (rule.kind !== "extractOnly" && standing === "cutUnanswered") {
      const flag = cutDocumentFlag(property.id);
      aiResults.push(flag.result);
      aiJustifications.push(flag.justification);
      gradedVerdicts.push(flag.graded);
      settlements.set(property.id, "answered");
      continue;
    }

    switch (rule.kind) {
      case "extractOnly":
        // No verdict is materialized for an extractOnly position; nothing to do.
        skippedPropertyIds.push(property.id);
        settlements.set(property.id, "notStated");
        break;
      case "presence":
        recordDeterministic(
          property,
          gradePresence(rule.expectation, askPresence(askContent)),
        );
        break;
      case "propertyConstraint":
        recordDeterministic(
          property,
          gradePropertyConstraint(
            rule.condition,
            askContent,
            fieldContentByPropertyId,
          ),
        );
        break;
      case "positionMatch": {
        const askValue = askText(askContent);
        if (askValue === null || askValue.trim().length === 0) {
          recordDeterministic(property, "missing");
          break;
        }
        positionMatchTasks.push({
          property,
          askValue,
          askFieldId: inputFieldByPropertyId.get(tool.askPropertyId)?.id,
        });
        break;
      }
      default: {
        rule satisfies never;
        panic(`Unhandled rule: ${String(rule)}`);
      }
    }
  }

  const passagesByFieldId = await fetchCitedPassagesByFieldId({
    scopedDb,
    workspaceId,
    fieldIds: positionMatchTasks.flatMap(({ askFieldId }) =>
      askFieldId === undefined ? [] : [askFieldId],
    ),
  });

  // Drain the position-match compares in bounded chunks so the per-entity LLM
  // fan-out stays capped (see POSITION_MATCH_CONCURRENCY).
  for (const chunk of chunkItems(
    positionMatchTasks,
    POSITION_MATCH_CONCURRENCY,
  )) {
    await Promise.all(
      chunk.map(async ({ property, askValue, askFieldId }) => {
        const passages =
          askFieldId === undefined
            ? []
            : arrayOrEmpty(passagesByFieldId.get(askFieldId));
        const graded = await gradeTierMatchForVerdict({
          askValue,
          tiers: resolveVerdictTiers(property.tool),
          passages,
          abortSignal,
          organizationId,
          admission,
          workspaceId,
          entityVersionId,
          propertyId: property.id,
          orgAIConfig,
          managedAIResidency,
          promptCachingEnabled,
          serviceTier,
          usageMetering,
        });
        const extracted = extractedFromCitedClause(
          fieldContentByPropertyId.get(property.tool.askPropertyId),
          passages,
        );
        if (Result.isError(graded)) {
          ungradedVerdicts.push({ propertyId: property.id, extracted });
          settlements.set(property.id, "failedTransient");
          return;
        }
        const records = tierMatchRecords({
          propertyId: property.id,
          graded: graded.value,
          extracted,
        });
        aiResults.push(records.result);
        gradedVerdicts.push(records.graded);
        aiJustifications.push(records.justification);
        settlements.set(property.id, "answered");
      }),
    );
  }

  return {
    aiResults,
    aiJustifications,
    gradedVerdicts,
    ungradedVerdicts,
    skippedPropertyIds,
    erroredPropertyIds,
    settlements,
  };
};
