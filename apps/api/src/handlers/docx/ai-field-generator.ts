/**
 * Model-backed generator for AI-fillable template fields (FieldMeta.aiPrompt).
 *
 * Kept separate from the pure `resolveAiFields` (which must stay free of any
 * model/provider dependency) and shared by every fill boundary — the chat
 * `fill_template` tool and the web fill + preview routes — so an AI placeholder
 * like "the scope of this power of attorney" is drafted identically wherever a
 * template is filled. Returns `undefined` when the org has no usable AI config,
 * so callers leave AI fields unfilled rather than erroring.
 */

import { chat, maxIterations } from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
import * as v from "valibot";

import {
  chatToolMapToArray,
  type ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import type { AiOccurrenceAdapter } from "@/api/handlers/docx/adapt-ai-fields";
import {
  maybeSkillTools,
  SKILL_REF_GENERATOR_GUIDANCE,
  type SkillToolsContext,
} from "@/api/handlers/docx/ai-skill-tools";
import type { AiConditionDecider } from "@/api/handlers/docx/resolve-ai-conditions";
import type { AiFieldGenerator } from "@/api/handlers/docx/resolve-ai-fields";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import type { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  abortControllerFromSignal,
  mergeGenerationOptions,
  resolveTanStackTextModel,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

/**
 * Usage-metering + analytics callbacks wired into every nested fill
 * generation. Optional so callers that cannot supply metering context
 * (or do not need it) keep working; when present, the analytics
 * middleware records a consumption ledger row per model step and
 * `captureError` reports a swallowed model failure.
 */
type AiFieldAnalytics = ReturnType<typeof createTanStackAIAnalyticsCallbacks>;

const AI_FIELD_TIMEOUT_MS = 20_000;
const AI_FIELD_MAX_TOKENS = 800;
// One step to (optionally) call load-skill, one to draft the value. Bounded so
// a skill-referencing prompt cannot loop the model indefinitely.
const SKILL_TOOL_MAX_STEPS = 4;

/**
 * Shared TanStack `chat()` setup for the one-shot field generators: resolves the
 * fast-role model, disables prompt caching (these calls are not cache-shared),
 * threads analytics middleware, and attaches the optional skill tool loop. Skill
 * refs need the agentic loop (load-skill then draft), so these calls go through
 * `chat()` directly rather than the tool-free `generateTanStack*ForRole` helpers.
 */
type FieldChatInput = {
  abortSignal: AbortSignal;
  aiAnalytics: AiFieldAnalytics | undefined;
  maxOutputTokens: number;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  prompt: string;
  skillTools: ChatToolMap | undefined;
  system: string | undefined;
};

type ResolvedFieldChat = {
  abortController: AbortController;
  caching: ReturnType<typeof resolveCaching>;
  messages: ModelMessage[];
  model: ReturnType<typeof resolveTanStackTextModel>;
};

const resolveFieldChat = ({
  abortSignal,
  orgAIConfig,
  organizationId,
  prompt,
}: FieldChatInput): ResolvedFieldChat => ({
  abortController: abortControllerFromSignal(abortSignal),
  caching: resolveCaching({
    promptCachingEnabled: false,
    role: "fast",
    scopeKey: organizationId,
  }),
  messages: [{ role: "user", content: prompt }],
  model: resolveTanStackTextModel({
    role: "fast",
    orgAIConfig,
    organizationId,
  }),
});

const generateFieldText = async (input: FieldChatInput): Promise<string> => {
  const { abortController, caching, messages, model } = resolveFieldChat(input);
  return await chat({
    adapter: model.adapter,
    messages,
    stream: false,
    abortController,
    ...systemPromptsPatch({ caching, model, system: input.system }),
    modelOptions: mergeGenerationOptions({
      caching,
      model,
      maxOutputTokens: input.maxOutputTokens,
      serviceTier: "standard",
      temperature: undefined,
    }),
    ...(input.aiAnalytics
      ? { middleware: [input.aiAnalytics.middleware] }
      : {}),
    ...(input.skillTools
      ? {
          tools: chatToolMapToArray(input.skillTools),
          agentLoopStrategy: maxIterations(SKILL_TOOL_MAX_STEPS),
        }
      : {}),
  });
};

const generateFieldObject = async <TSchema extends v.GenericSchema>(
  input: FieldChatInput & { outputSchema: TSchema },
): Promise<v.InferOutput<TSchema>> => {
  const { abortController, caching, messages, model } = resolveFieldChat(input);
  const output = await chat({
    adapter: model.adapter,
    messages,
    outputSchema: toTanStackValibotSchema(input.outputSchema),
    abortController,
    ...systemPromptsPatch({ caching, model, system: input.system }),
    modelOptions: mergeGenerationOptions({
      caching,
      model,
      maxOutputTokens: input.maxOutputTokens,
      serviceTier: "standard",
      temperature: undefined,
    }),
    ...(input.aiAnalytics
      ? { middleware: [input.aiAnalytics.middleware] }
      : {}),
    ...(input.skillTools
      ? {
          tools: chatToolMapToArray(input.skillTools),
          agentLoopStrategy: maxIterations(SKILL_TOOL_MAX_STEPS),
        }
      : {}),
  });
  return v.parse(input.outputSchema, output);
};

export const buildAiFieldGenerator = ({
  orgAIConfig,
  organizationId,
  skillContext,
  aiAnalytics,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  /** When present, prompts that reference a skill get load-skill tools. */
  skillContext?: SkillToolsContext | undefined;
  /** When present, model usage is metered and failures are captured. */
  aiAnalytics?: AiFieldAnalytics | undefined;
}): AiFieldGenerator | undefined => {
  // Resolve via org BYOK or the deployment's instance provider; skip (leave AI
  // fields unfilled) only when neither can supply a model.
  if (!orgAIConfig && !hasTanStackInstanceProvider()) {
    return undefined;
  }
  return async ({ prompt, values, documentText, item }) => {
    try {
      const skillTools = maybeSkillTools(prompt, skillContext);
      // Injected only for fields that opted in via aiSeesDocument; omitted
      // entirely otherwise so non-opted fields cost the same tokens as before.
      const documentSection =
        documentText !== undefined && documentText.trim() !== ""
          ? `\nDocument:\n${documentText}\n`
          : "";
      // Per-item positional context for array-scoped fields; omitted entirely
      // for top-level fields so their prompt is unchanged.
      const itemSection =
        item !== undefined
          ? `\nThis is item ${String(item.index)} of ${String(item.count)}.\n`
          : "";
      const text = await generateFieldText({
        abortSignal: AbortSignal.timeout(AI_FIELD_TIMEOUT_MS),
        aiAnalytics,
        maxOutputTokens: AI_FIELD_MAX_TOKENS,
        orgAIConfig,
        organizationId,
        prompt: `You are drafting a single field of a legal document. Instruction: ${prompt}
${itemSection}${documentSection}
Known details (JSON):
${JSON.stringify(values)}

Reply with only the text for this field — no preamble, no quotes, no markdown.`,
        skillTools,
        system: skillTools ? SKILL_REF_GENERATOR_GUIDANCE : undefined,
      });
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch (error) {
      aiAnalytics?.captureError(error);
      return undefined;
    }
  };
};

const AI_CONDITION_TIMEOUT_MS = 20_000;
const AI_CONDITION_MAX_TOKENS = 400;

// strictObject + object root: OpenAI strict structured output rejects a bare
// boolean root, so the yes/no answer rides in a single required boolean field.
const conditionDecisionSchema = v.strictObject({
  decision: v.boolean(),
});

/**
 * Model-backed decider for AI-decided boolean fields (a boolean FieldMeta with
 * an aiPrompt). Returns `undefined` when the org has no usable AI config or the
 * model fails, so callers leave the condition unset — the referencing
 * `{{#if}}` is then falsy and its block is excluded (the correct default).
 */
export const buildAiConditionDecider = ({
  orgAIConfig,
  organizationId,
  skillContext,
  aiAnalytics,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  /** When present, prompts that reference a skill get load-skill tools. */
  skillContext?: SkillToolsContext | undefined;
  /** When present, model usage is metered and failures are captured. */
  aiAnalytics?: AiFieldAnalytics | undefined;
}): AiConditionDecider | undefined => {
  // Resolve via org BYOK or the deployment's instance provider; skip (leave AI
  // fields unfilled) only when neither can supply a model.
  if (!orgAIConfig && !hasTanStackInstanceProvider()) {
    return undefined;
  }
  return async ({ prompt, values }) => {
    try {
      const skillTools = maybeSkillTools(prompt, skillContext);
      const { decision } = await generateFieldObject({
        abortSignal: AbortSignal.timeout(AI_CONDITION_TIMEOUT_MS),
        aiAnalytics,
        maxOutputTokens: AI_CONDITION_MAX_TOKENS,
        orgAIConfig,
        organizationId,
        outputSchema: conditionDecisionSchema,
        prompt: `You are deciding one yes/no condition of a legal document. Question: ${prompt}

Known details (JSON):
${JSON.stringify(values)}

Decide true (yes) or false (no) for this condition.`,
        skillTools,
        system: skillTools ? SKILL_REF_GENERATOR_GUIDANCE : undefined,
      });
      return decision;
    } catch (error) {
      aiAnalytics?.captureError(error);
      return undefined;
    }
  };
};

const AI_ADAPT_TIMEOUT_MS = 30_000;
const AI_ADAPT_MAX_TOKENS = 2000;

// strictObject (no optional members): OpenAI strict structured output rejects
// plain objects and optional properties.
const occurrenceRenderingsSchema = v.strictObject({
  renderings: v.array(v.string()),
});

const ADAPT_SYSTEM_PROMPT =
  "You adapt one field value of a legal document so it reads naturally at " +
  "each place it appears. Match the document's language and grammar: in " +
  "inflected languages adjust case, declension, and surrounding phrasing " +
  '(e.g. "czech law" may become "according to the laws of the Czech ' +
  'Republic"). Never add or change facts.';

const buildAdaptPrompt = (
  {
    stub,
    fieldPath,
    label,
    prompt,
    occurrences,
  }: Parameters<AiOccurrenceAdapter>[0],
  documentLanguages: readonly string[],
): string => {
  const fieldLine = label ? `${fieldPath} (${label})` : fieldPath;
  const guidance = prompt ? `Field instruction: ${prompt}\n` : "";
  const languagesLine =
    documentLanguages.length > 0
      ? `Document languages: ${documentLanguages.join(", ")}\n`
      : "";
  const contexts = occurrences
    .map(
      (occurrence, index) =>
        `Occurrence ${String(index + 1)}:\n${occurrence.context}`,
    )
    .join("\n\n");
  return `Field: ${fieldLine}
${guidance}${languagesLine}Value to adapt: ${stub}

Each occurrence below shows the surrounding document text with the {{${fieldPath}}} marker where the value goes. Return exactly ${String(occurrences.length)} renderings, in order — rendering N replaces the marker in occurrence N. Each rendering is the replacement text only: no quotes, no markdown, no surrounding sentence.

${contexts}`;
};

/**
 * Model-backed occurrence adapter for AI-adapted fields (FieldMeta.aiAdapt).
 * Returns `undefined` when the org has no usable AI config or the model
 * fails, so the fill falls back to the plain stub substitution.
 */
export const buildAiOccurrenceAdapter = ({
  orgAIConfig,
  organizationId,
  documentLanguages = [],
  skillContext,
  aiAnalytics,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  /** Template-level BCP-47 tags (primary first); when present the model
   *  is told which languages the document uses, which improves
   *  inflection in bilingual templates. */
  documentLanguages?: readonly string[];
  /** When present, instructions that reference a skill get load-skill tools. */
  skillContext?: SkillToolsContext | undefined;
  /** When present, model usage is metered and failures are captured. */
  aiAnalytics?: AiFieldAnalytics | undefined;
}): AiOccurrenceAdapter | undefined => {
  // Resolve via org BYOK or the deployment's instance provider; skip (leave AI
  // fields unfilled) only when neither can supply a model.
  if (!orgAIConfig && !hasTanStackInstanceProvider()) {
    return undefined;
  }
  return async (input) => {
    try {
      const skillTools = maybeSkillTools(input.prompt ?? "", skillContext);
      const { renderings } = await generateFieldObject({
        abortSignal: AbortSignal.timeout(AI_ADAPT_TIMEOUT_MS),
        aiAnalytics,
        maxOutputTokens: AI_ADAPT_MAX_TOKENS,
        orgAIConfig,
        organizationId,
        outputSchema: occurrenceRenderingsSchema,
        prompt: buildAdaptPrompt(input, documentLanguages),
        skillTools,
        system: skillTools
          ? `${ADAPT_SYSTEM_PROMPT} ${SKILL_REF_GENERATOR_GUIDANCE}`
          : ADAPT_SYSTEM_PROMPT,
      });
      if (renderings.length !== input.occurrences.length) {
        return undefined;
      }
      const trimmed = renderings.map((rendering) => rendering.trim());
      return trimmed.some((rendering) => rendering.length === 0)
        ? undefined
        : trimmed;
    } catch (error) {
      aiAnalytics?.captureError(error);
      return undefined;
    }
  };
};
