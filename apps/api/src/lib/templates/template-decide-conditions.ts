/**
 * What the organization's decision model says about a template's AI-decided
 * conditions, before anything is filled.
 *
 * The fill decides each condition as it reaches it and writes the answer into
 * the document; by then the person filling the form can no longer see what was
 * decided, let alone disagree. This asks every condition of one template in a
 * single call so the form can show the answer and its confidence while the
 * values are still being typed, and let the person override it.
 *
 * The decision model only: no generative fallback here. The fill keeps its
 * cascade (decide, then the generative model when the answer is under the
 * floor), so a condition this reports as undecided may still be answered at
 * fill time. With no decision model configured every condition comes back
 * `no-backend`, which is the ordinary state of a self-hosted instance.
 */

import { panic, Result } from "better-result";
import type { Result as ResultType } from "better-result";
import * as v from "valibot";

import type { DecisionUndecidedReason } from "@stll/api-contract/ai-decision-provider";
import { evaluateCondition, resolvePath } from "@stll/template-conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  clauseDirectiveContainer,
  validateClauseBodyDirectives,
} from "@/api/lib/clauses/clause-directives";
import {
  CONDITION_DECISION_ID,
  conditionQuestion,
  conditionsState,
} from "@/api/lib/docx/ai-condition-question";
import { omitSourceBoundValues } from "@/api/lib/docx/ai-visible-values";
import { deriveManifestFromDocx } from "@/api/lib/docx/derived-manifest";
import { discoverContainerFields } from "@/api/lib/docx/discover-template";
import { isAiConditionField } from "@/api/lib/docx/resolve-ai-conditions";
import { resolveClauseSlotSources } from "@/api/lib/docx/resolve-clause-slots";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { loadStoredTemplateSource } from "@/api/lib/templates/template-fill-service";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import type { Decision } from "@/api/lib/workflow/decisions/decide";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionUsageMetering } from "@/api/lib/workflow/decisions/decision-usage";
import type {
  NoulAnswer,
  NoulQuestion,
} from "@/api/lib/workflow/decisions/system-one";

/** The form asks between keystrokes; a slower answer is stale when it lands. */
const DECIDE_CONDITIONS_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_CLAUSE_TEXT_LENGTH = 250_000;
const MAX_PREVIEW_MANIFEST_CACHE_ENTRIES = 100;
// Older rows have no cached targets. Cache their immutable template version,
// never clause bodies: clause publications and link syncs remain visible.
const previewManifestCache = new Map<string, TemplateManifest>();

type TemplateConditionDecision =
  | {
      state: "decided";
      decidedBy: "decision_model";
      value: boolean;
      /** Probability of the side chosen, not of yes. */
      probability: number;
      confidence: number;
    }
  | {
      state: "decided";
      decidedBy: "user";
      value: boolean;
    }
  | { state: "undecided"; reason: DecisionUndecidedReason };

export type TemplateConditionAnswer = {
  path: string;
  /** The field's label as the fill form shows it; its path when unlabelled. */
  label: string;
  decision: TemplateConditionDecision;
};

export const templateConditionPreviewSchema = v.strictObject({
  state: v.literal("incomplete"),
  reason: v.picklist(["clause-limit", "text-limit"]),
});

export type TemplateConditionDecisions = {
  conditions: TemplateConditionAnswer[];
  preview?: v.InferOutput<typeof templateConditionPreviewSchema> | undefined;
  /** The versioned model that answered; null when nothing was asked or could be. */
  model: string | null;
};

type TemplateAiCondition = { path: string; label: string; prompt: string };

/** The AI-decided conditions of a manifest, in manifest order. */
export const templateAiConditions = (
  fields: readonly FieldMeta[],
): TemplateAiCondition[] =>
  fields.filter(isAiConditionField).map((field) => ({
    path: field.path,
    label: field.label ?? field.path,
    prompt: field.aiPrompt,
  }));

const toConditionDecision = (
  decision: Decision<NoulAnswer>,
): TemplateConditionDecision => {
  switch (decision.state) {
    case "undecided":
      return { state: "undecided", reason: decision.reason };
    case "decided": {
      const value = decision.answer.noul > 0.5;
      return {
        state: "decided",
        decidedBy: "decision_model",
        value,
        // The reading's probability is the yes; on a no the chosen side's is
        // its complement.
        probability: value ? decision.probability : 1 - decision.probability,
        confidence: decision.confidence,
      };
    }
    default:
      decision satisfies never;
      return panic("Unhandled condition decision state");
  }
};

export type DecideTemplateConditionsOptions = {
  fields: readonly FieldMeta[];
  values: Record<string, unknown>;
  orgAIConfig: OrgAIConfig | null;
  abortSignal?: AbortSignal | undefined;
  /** Injected by tests; the org's resolved decision model otherwise. */
  client?: DecisionModel | null | undefined;
  usageMetering?: DecisionUsageMetering | undefined;
};

/**
 * Every AI-decided condition of one manifest, in one call: they share a state
 * (the values), which is how the provider prices a batch and what keeps the
 * form's round trip single.
 */
export const decideTemplateConditions = async ({
  fields,
  values,
  orgAIConfig,
  abortSignal,
  client,
  usageMetering,
}: DecideTemplateConditionsOptions): Promise<TemplateConditionDecisions> => {
  const conditions = templateAiConditions(fields);
  const supplied = new Map<string, boolean>();
  const questions: Record<string, NoulQuestion> = {};
  for (const { path, prompt } of conditions) {
    const existing = resolvePath(path, values);
    if (existing !== undefined && existing !== "") {
      supplied.set(path, evaluateCondition(path, values));
      continue;
    }
    questions[path] = conditionQuestion(prompt);
  }

  if (supplied.size === conditions.length) {
    return {
      conditions: conditions.map(({ path, label }) => ({
        path,
        label,
        decision: {
          state: "decided",
          decidedBy: "user",
          value:
            supplied.get(path) ??
            panic(`Supplied decision missing for condition "${path}"`),
        },
      })),
      model: null,
    };
  }

  const { decisions, model } = await decideMany({
    dataClass: "customer",
    id: CONDITION_DECISION_ID,
    orgAIConfig,
    // The fill hides source-bound values from the model (they are resolved
    // from the matter at fill time, not typed), so this hides the same ones —
    // otherwise the form previews an answer to a different question.
    state: conditionsState(omitSourceBoundValues({ values, fields })),
    questions,
    timeoutMs: DECIDE_CONDITIONS_TIMEOUT_MS,
    abortSignal,
    client,
    usageMetering,
  });

  return {
    conditions: conditions.map(({ path, label }) => {
      const suppliedValue = supplied.get(path);
      if (suppliedValue !== undefined) {
        return {
          path,
          label,
          decision: {
            state: "decided",
            decidedBy: "user",
            value: suppliedValue,
          },
        };
      }
      const decision = decisions[path];
      if (decision === undefined) {
        return panic(`Decision missing for condition "${path}"`);
      }
      return { path, label, decision: toConditionDecision(decision) };
    }),
    model,
  };
};

export type TemplateDecideConditionsProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  body: { values: Record<string, unknown> };
  orgAIConfig: OrgAIConfig | null;
  abortSignal: AbortSignal;
  /** Injected by tests; the org's resolved decision model otherwise. */
  client?: DecisionModel | null | undefined;
  usageMetering?: DecisionUsageMetering | undefined;
};

type DerivedManifestFieldsOptions = Pick<
  TemplateDecideConditionsProps,
  "templateId" | "organizationId" | "scopedDb"
> & { cacheKey: string };

/**
 * The fields the document declares, read out of its file: what a row stored
 * before the manifest cache was written carries instead of a manifest. Fails
 * as the stored template's load does (gone, or its file refused by the scan).
 */
const derivedPreviewManifest = async ({
  templateId,
  organizationId,
  scopedDb,
  cacheKey,
}: DerivedManifestFieldsOptions): Promise<
  ResultType<TemplateManifest, HandlerError<404 | 422 | 500 | 503>>
> => {
  const cached = previewManifestCache.get(cacheKey);
  if (cached !== undefined) {
    return Result.ok(cached);
  }
  const source = await loadStoredTemplateSource({
    templateId,
    organizationId,
    scopedDb,
  });
  if (Result.isError(source)) {
    return Result.err(source.error);
  }
  const manifest = await deriveManifestFromDocx(source.value.file);
  if (previewManifestCache.size >= MAX_PREVIEW_MANIFEST_CACHE_ENTRIES) {
    const oldest = previewManifestCache.keys().next().value;
    if (oldest !== undefined) {
      previewManifestCache.delete(oldest);
    }
  }
  previewManifestCache.set(cacheKey, manifest);
  return Result.ok(manifest);
};

/**
 * `templates.condition-decisions.get`'s logic: the stored template's manifest
 * and one decision call over the conditions it declares. A boolean the caller
 * supplied is reported as theirs and omitted from the model's questions.
 *
 * The manifest column is the cache of reading the document that exists for
 * exactly this kind of read (see `derived-manifest.ts`), and the form asks on
 * every typing pause. Cached slots select only their resolved clause bodies;
 * marker-free bodies require no DOCX or clause-container parse. Conditions
 * from per-fill clause edits are not previewed: this
 * endpoint describes the stored template and its links only.
 */
export const templateDecideConditionsLogic = async ({
  scopedDb,
  organizationId,
  templateId,
  body: { values },
  orgAIConfig,
  abortSignal,
  client,
  usageMetering,
}: TemplateDecideConditionsProps): Promise<
  ResultType<TemplateConditionDecisions, HandlerError<404 | 422 | 500 | 503>>
> => {
  // The organization predicate is redundant with RLS on `scopedDb` and stays
  // anyway, for the reason `loadStoredTemplateSource` states: a cross-tenant
  // addressable id should not rest on a single mechanism.
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: {
        id: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: { manifest: true, currentVersion: true, s3Key: true },
    }),
  );
  if (!template) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  let manifest = template.manifest;
  if (manifest?.clauseSlots === undefined) {
    const derived = await derivedPreviewManifest({
      templateId,
      organizationId,
      scopedDb,
      cacheKey: `${organizationId}:${templateId}:${template.currentVersion}:${template.s3Key}`,
    });
    if (Result.isError(derived)) {
      return Result.err(derived.error);
    }
    manifest = derived.value;
  }
  let fields = manifest.fields;
  const slots =
    manifest.clauseSlots ??
    panic("Derived preview manifest is missing clause slots");
  if (slots.length > LIMITS.templateClausesPerTemplate) {
    return Result.ok({
      conditions: [],
      model: null,
      preview: { state: "incomplete", reason: "clause-limit" },
    });
  }
  const resolved = await resolveClauseSlotSources(
    templateId,
    slots,
    scopedDb,
    organizationId,
  );
  const clauseFields = new Map<string, FieldMeta>();
  let textLength = 0;
  for (const { body } of resolved.values()) {
    for (const paragraph of body) {
      textLength +=
        paragraph.runs?.reduce((total, run) => total + run.text.length, 0) ??
        paragraph.text.length;
    }
    if (textLength > MAX_PREVIEW_CLAUSE_TEXT_LENGTH) {
      return Result.ok({
        conditions: [],
        model: null,
        preview: { state: "incomplete", reason: "text-limit" },
      });
    }
    if (
      !body.some((paragraph) => {
        const text =
          paragraph.runs?.map(({ text: runText }) => runText).join("") ??
          paragraph.text;
        return text.includes("{{") || text.includes("{%");
      }) ||
      Result.isError(validateClauseBodyDirectives(body))
    ) {
      continue;
    }
    for (const field of discoverContainerFields(
      clauseDirectiveContainer(body),
    )) {
      clauseFields.set(field.path, field);
    }
  }
  // Clause declarations use the fill owner's precedence: template fields win.
  for (const field of fields) {
    clauseFields.set(field.path, field);
  }
  fields = [...clauseFields.values()];

  // A template with no AI-decided condition asks nothing, so it neither reads
  // the org's AI config nor reaches a model.
  if (templateAiConditions(fields).length === 0) {
    return Result.ok({ conditions: [], model: null });
  }

  return Result.ok(
    await decideTemplateConditions({
      fields,
      values,
      orgAIConfig,
      abortSignal,
      client,
      usageMetering,
    }),
  );
};
