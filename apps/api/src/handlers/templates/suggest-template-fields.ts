/**
 * The model half of AI template preparation: given a (typically filled)
 * document's plain text, ask the model which values should become fillable
 * fields. Pairs with `applyFieldSuggestions`, which deterministically rewrites
 * the document from the returned suggestions.
 *
 * Uses the same structured-output pattern as workflow generation
 * (`streamText` + `Output.object`). A failure or unavailable model yields an
 * empty list so the caller can fall back to plain `{{marker}}` discovery.
 */

import { valibotSchema } from "@ai-sdk/valibot";
import { Output, streamText } from "ai";
import * as v from "valibot";

import type { FieldSuggestion } from "@/api/handlers/docx/apply-field-suggestions";
import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import type { SafeId } from "@/api/lib/branded-types";

const SUGGEST_TIMEOUT_MS = 45_000;

export const fieldSuggestionsSchema = v.object({
  suggestions: v.array(
    v.object({
      literalText: v.string(),
      fieldPath: v.string(),
      inputType: v.optional(
        v.picklist(["text", "textarea", "number", "boolean", "date", "select"]),
      ),
      aiPrompt: v.optional(v.string()),
    }),
  ),
});

const SYSTEM_PROMPT =
  "You convert a filled legal document into a reusable template. You identify " +
  "the values that should become fillable fields and copy their exact text. " +
  "You never invent values or map text that does not appear verbatim.";

const buildPrompt = (documentText: string): string =>
  `Identify the values in this document that should become fillable fields — ` +
  `party names, addresses, registration numbers (KRS / NIP / REGON), monetary ` +
  `amounts, dates, the signatory's name and role, and free-text sections such ` +
  `as the scope of a power of attorney.\n\n` +
  `For each, return:\n` +
  `- literalText: the EXACT text in the document to replace, copied verbatim\n` +
  `- fieldPath: a dot-separated name, e.g. company.name, company.krs, ` +
  `signatory.name, signatory.role, signing_date, scope\n` +
  `- inputType: one of text, textarea, number, boolean, date, select\n` +
  `- aiPrompt: ONLY for free-text sections that should be drafted by AI at fill ` +
  `time (e.g. the scope of the power of attorney) — an instruction describing ` +
  `what to draft. Omit it for ordinary fields.\n\n` +
  `Document:\n${documentText}`;

export const suggestTemplateFields = async ({
  documentText,
  orgAIConfig,
  organizationId,
}: {
  documentText: string;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
}): Promise<FieldSuggestion[]> => {
  try {
    const result = streamText({
      abortSignal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
      messages: [{ role: "user", content: buildPrompt(documentText) }],
      model: getModelForRole("fast", orgAIConfig, {
        promptCachingEnabled: false,
        scopeKey: organizationId,
        organizationId,
      }),
      output: Output.object({ schema: valibotSchema(fieldSuggestionsSchema) }),
      system: SYSTEM_PROMPT,
    });
    const { suggestions } = await result.output;
    return suggestions;
  } catch {
    return [];
  }
};
