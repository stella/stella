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

import { generateText } from "ai";

import type { AiFieldGenerator } from "@/api/handlers/docx/resolve-ai-fields";
import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
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
