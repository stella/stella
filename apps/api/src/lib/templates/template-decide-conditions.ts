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

import { evaluateCondition, resolvePath } from "@stll/template-conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CONDITION_DECISION_ID,
  conditionQuestion,
  conditionsState,
} from "@/api/lib/docx/ai-condition-question";
import { omitSourceBoundValues } from "@/api/lib/docx/ai-visible-values";
import { deriveManifestFromDocx } from "@/api/lib/docx/derived-manifest";
import { isAiConditionField } from "@/api/lib/docx/resolve-ai-conditions";
import type { FieldMeta } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadStoredTemplateSource } from "@/api/lib/templates/template-fill-service";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import type {
  Decision,
  DecisionUndecidedReason,
} from "@/api/lib/workflow/decisions/decide";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionUsageMetering } from "@/api/lib/workflow/decisions/decision-usage";
import type {
  NoulAnswer,
  NoulQuestion,
} from "@/api/lib/workflow/decisions/system-one";

/** The form asks between keystrokes; a slower answer is stale when it lands. */
const DECIDE_CONDITIONS_TIMEOUT_MS = 10_000;

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

export type TemplateConditionDecisions = {
  conditions: TemplateConditionAnswer[];
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
>;

/**
 * The fields the document declares, read out of its file: what a row stored
 * before the manifest cache was written carries instead of a manifest. Fails
 * as the stored template's load does (gone, or its file refused by the scan).
 */
const derivedManifestFields = async ({
  templateId,
  organizationId,
  scopedDb,
}: DerivedManifestFieldsOptions): Promise<
  ResultType<FieldMeta[], HandlerError<404 | 422 | 500 | 503>>
> => {
  const source = await loadStoredTemplateSource({
    templateId,
    organizationId,
    scopedDb,
  });
  if (Result.isError(source)) {
    return Result.err(source.error);
  }
  return Result.ok((await deriveManifestFromDocx(source.value.file)).fields);
};

/**
 * `templates.condition-decisions.get`'s logic: the stored template's manifest
 * and one decision call over the conditions it declares. A boolean the caller
 * supplied is reported as theirs and omitted from the model's questions.
 *
 * The manifest column is the cache of reading the document that exists for
 * exactly this kind of read (see `derived-manifest.ts`), and the form asks on
 * every typing pause, so the fields come from it rather than from a DOCX
 * pulled out of object storage per call.
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
      columns: { manifest: true },
    }),
  );
  if (!template) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  let fields = template.manifest?.fields;
  if (fields === undefined) {
    const derived = await derivedManifestFields({
      templateId,
      organizationId,
      scopedDb,
    });
    if (Result.isError(derived)) {
      return Result.err(derived.error);
    }
    fields = derived.value;
  }

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
