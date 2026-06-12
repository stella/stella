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

import { generateText, Output, stepCountIs, streamText } from "ai";
import * as v from "valibot";

import type { AiOccurrenceAdapter } from "@/api/handlers/docx/adapt-ai-fields";
import {
  maybeSkillTools,
  SKILL_REF_GENERATOR_GUIDANCE,
  type SkillToolsContext,
} from "@/api/handlers/docx/ai-skill-tools";
import type { AiConditionDecider } from "@/api/handlers/docx/resolve-ai-conditions";
import type { AiFieldGenerator } from "@/api/handlers/docx/resolve-ai-fields";
import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import type { SafeId } from "@/api/lib/branded-types";

const AI_FIELD_TIMEOUT_MS = 20_000;
const AI_FIELD_MAX_TOKENS = 800;
// One step to (optionally) call load-skill, one to draft the value. Bounded so
// a skill-referencing prompt cannot loop the model indefinitely.
const SKILL_TOOL_MAX_STEPS = 4;

export const buildAiFieldGenerator = ({
  orgAIConfig,
  organizationId,
  skillContext,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  /** When present, prompts that reference a skill get load-skill tools. */
  skillContext?: SkillToolsContext | undefined;
}): AiFieldGenerator | undefined => {
  if (!orgAIConfig) {
    return undefined;
  }
  return async ({ prompt, values, documentText }) => {
    try {
      const skillTools = maybeSkillTools(prompt, skillContext);
      // Injected only for fields that opted in via aiSeesDocument; omitted
      // entirely otherwise so non-opted fields cost the same tokens as before.
      const documentSection =
        documentText !== undefined && documentText.trim() !== ""
          ? `\nDocument:\n${documentText}\n`
          : "";
      const { text } = await generateText({
        abortSignal: AbortSignal.timeout(AI_FIELD_TIMEOUT_MS),
        maxOutputTokens: AI_FIELD_MAX_TOKENS,
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled: false,
          scopeKey: organizationId,
          organizationId,
          serviceTier: "standard",
        }),
        ...(skillTools
          ? {
              tools: skillTools,
              stopWhen: stepCountIs(SKILL_TOOL_MAX_STEPS),
              system: SKILL_REF_GENERATOR_GUIDANCE,
            }
          : {}),
        prompt: `You are drafting a single field of a legal document. Instruction: ${prompt}
${documentSection}
Known details (JSON):
${JSON.stringify(values)}

Reply with only the text for this field — no preamble, no quotes, no markdown.`,
      });
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
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
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  /** When present, prompts that reference a skill get load-skill tools. */
  skillContext?: SkillToolsContext | undefined;
}): AiConditionDecider | undefined => {
  if (!orgAIConfig) {
    return undefined;
  }
  return async ({ prompt, values }) => {
    try {
      const skillTools = maybeSkillTools(prompt, skillContext);
      const result = streamText({
        abortSignal: AbortSignal.timeout(AI_CONDITION_TIMEOUT_MS),
        maxOutputTokens: AI_CONDITION_MAX_TOKENS,
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled: false,
          scopeKey: organizationId,
          organizationId,
          serviceTier: "standard",
        }),
        ...(skillTools
          ? {
              tools: skillTools,
              stopWhen: stepCountIs(SKILL_TOOL_MAX_STEPS),
              system: SKILL_REF_GENERATOR_GUIDANCE,
            }
          : {}),
        output: Output.object({
          schema: strictOutputSchema(conditionDecisionSchema),
        }),
        prompt: `You are deciding one yes/no condition of a legal document. Question: ${prompt}

Known details (JSON):
${JSON.stringify(values)}

Decide true (yes) or false (no) for this condition.`,
      });
      const { decision } = await result.output;
      return decision;
    } catch {
      return undefined;
    }
  };
};

const AI_ADAPT_TIMEOUT_MS = 30_000;
const AI_ADAPT_MAX_TOKENS = 2000;

// strictObject (no optional members): OpenAI strict structured output rejects
// plain objects and optional properties (see strictOutputSchema).
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
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  /** Template-level BCP-47 tags (primary first); when present the model
   *  is told which languages the document uses, which improves
   *  inflection in bilingual templates. */
  documentLanguages?: readonly string[];
  /** When present, instructions that reference a skill get load-skill tools. */
  skillContext?: SkillToolsContext | undefined;
}): AiOccurrenceAdapter | undefined => {
  if (!orgAIConfig) {
    return undefined;
  }
  return async (input) => {
    try {
      const skillTools = maybeSkillTools(input.prompt ?? "", skillContext);
      const result = streamText({
        abortSignal: AbortSignal.timeout(AI_ADAPT_TIMEOUT_MS),
        maxOutputTokens: AI_ADAPT_MAX_TOKENS,
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled: false,
          scopeKey: organizationId,
          organizationId,
          serviceTier: "standard",
        }),
        ...(skillTools
          ? { tools: skillTools, stopWhen: stepCountIs(SKILL_TOOL_MAX_STEPS) }
          : {}),
        output: Output.object({
          schema: strictOutputSchema(occurrenceRenderingsSchema),
        }),
        prompt: buildAdaptPrompt(input, documentLanguages),
        system: skillTools
          ? `${ADAPT_SYSTEM_PROMPT} ${SKILL_REF_GENERATOR_GUIDANCE}`
          : ADAPT_SYSTEM_PROMPT,
      });
      const { renderings } = await result.output;
      if (renderings.length !== input.occurrences.length) {
        return undefined;
      }
      const trimmed = renderings.map((rendering) => rendering.trim());
      return trimmed.some((rendering) => rendering.length === 0)
        ? undefined
        : trimmed;
    } catch {
      return undefined;
    }
  };
};
