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

import { generateText, Output, streamText } from "ai";
import * as v from "valibot";

import type { AiOccurrenceAdapter } from "@/api/handlers/docx/adapt-ai-fields";
import type { AiLookupFormatter } from "@/api/handlers/docx/lookup-fields";
import type { AiFieldGenerator } from "@/api/handlers/docx/resolve-ai-fields";
import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import type { SafeId } from "@/api/lib/branded-types";

const AI_FIELD_TIMEOUT_MS = 20_000;
const AI_FIELD_MAX_TOKENS = 800;

export const buildAiFieldGenerator = ({
  orgAIConfig,
  organizationId,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
}): AiFieldGenerator | undefined => {
  if (!orgAIConfig) {
    return undefined;
  }
  return async ({ prompt, values }) => {
    try {
      const { text } = await generateText({
        abortSignal: AbortSignal.timeout(AI_FIELD_TIMEOUT_MS),
        maxOutputTokens: AI_FIELD_MAX_TOKENS,
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled: false,
          scopeKey: organizationId,
          organizationId,
          serviceTier: "standard",
        }),
        prompt: `You are drafting a single field of a legal document. Instruction: ${prompt}

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

const AI_LOOKUP_FORMAT_TIMEOUT_MS = 20_000;
const AI_LOOKUP_FORMAT_MAX_TOKENS = 600;

// strictObject + nullable-required member: OpenAI strict structured output
// rejects plain objects and optional properties (see strictOutputSchema).
const lookupFormattingSchema = v.strictObject({
  // null when the instruction cannot be satisfied from the registry data;
  // callers then fall back to the deterministic rendering.
  formatted: v.nullable(v.string()),
});

const LOOKUP_FORMAT_SYSTEM_PROMPT =
  "You format official company-register data into one text fragment for a " +
  "legal document, following the given instruction (e.g. bracketed slots " +
  "for the company name, seat, and registration number). Use only the " +
  "facts in the provided registry data; never invent or guess values. " +
  "Match the instruction's language. Return null when the instruction " +
  "cannot be satisfied from the data.";

/**
 * Model-backed formatter for registry-lookup fields (FieldMeta.lookup with
 * an aiFormat instruction). Returns `undefined` when the org has no usable
 * AI config or the model fails, so the fill falls back to the deterministic
 * "name, seat" rendering.
 */
export const buildAiLookupFormatter = ({
  orgAIConfig,
  organizationId,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
}): AiLookupFormatter | undefined => {
  if (!orgAIConfig) {
    return undefined;
  }
  return async ({ instruction, fieldPath, hit }) => {
    try {
      const result = streamText({
        abortSignal: AbortSignal.timeout(AI_LOOKUP_FORMAT_TIMEOUT_MS),
        maxOutputTokens: AI_LOOKUP_FORMAT_MAX_TOKENS,
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled: false,
          scopeKey: organizationId,
          organizationId,
          serviceTier: "standard",
        }),
        output: Output.object({
          schema: strictOutputSchema(lookupFormattingSchema),
        }),
        prompt: `Field: ${fieldPath}
Formatting instruction: ${instruction}

Registry data (JSON):
${JSON.stringify(hit)}

Return the formatted text only — no preamble, no quotes, no markdown.`,
        system: LOOKUP_FORMAT_SYSTEM_PROMPT,
      });
      const { formatted } = await result.output;
      if (formatted === null) {
        return undefined;
      }
      const trimmed = formatted.trim();
      return trimmed.length > 0 ? trimmed : undefined;
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

const buildAdaptPrompt = ({
  stub,
  fieldPath,
  label,
  prompt,
  occurrences,
}: Parameters<AiOccurrenceAdapter>[0]): string => {
  const fieldLine = label ? `${fieldPath} (${label})` : fieldPath;
  const guidance = prompt ? `Field instruction: ${prompt}\n` : "";
  const contexts = occurrences
    .map(
      (occurrence, index) =>
        `Occurrence ${String(index + 1)}:\n${occurrence.context}`,
    )
    .join("\n\n");
  return `Field: ${fieldLine}
${guidance}Value to adapt: ${stub}

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
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
}): AiOccurrenceAdapter | undefined => {
  if (!orgAIConfig) {
    return undefined;
  }
  return async (input) => {
    try {
      const result = streamText({
        abortSignal: AbortSignal.timeout(AI_ADAPT_TIMEOUT_MS),
        maxOutputTokens: AI_ADAPT_MAX_TOKENS,
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled: false,
          scopeKey: organizationId,
          organizationId,
          serviceTier: "standard",
        }),
        output: Output.object({
          schema: strictOutputSchema(occurrenceRenderingsSchema),
        }),
        prompt: buildAdaptPrompt(input),
        system: ADAPT_SYSTEM_PROMPT,
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
