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

import { Output, streamText } from "ai";
import * as v from "valibot";

import { isFieldPath } from "@stll/template-conditions";

import type { FieldSuggestion } from "@/api/handlers/docx/apply-field-suggestions";
import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import type { SafeId } from "@/api/lib/branded-types";

const SUGGEST_TIMEOUT_MS = 45_000;

// strictObject + nullable (not object/optional): OpenAI's strict structured
// output rejects schema objects without `additionalProperties: false` and any
// property missing from `required` — so optionals must be required-but-nullable
// ("Invalid schema for response_format" — fails on gpt-* fast models otherwise).
export const fieldSuggestionsSchema = v.strictObject({
  suggestions: v.array(
    v.strictObject({
      literalText: v.string(),
      fieldPath: v.string(),
      inputType: v.nullable(
        v.picklist(["text", "textarea", "number", "boolean", "date", "select"]),
      ),
      label: v.nullable(v.string()),
      exampleValue: v.nullable(v.string()),
      aiPrompt: v.nullable(v.string()),
    }),
  ),
});

const SYSTEM_PROMPT =
  "You convert a filled legal document into a reusable template. You identify " +
  "the values that should become fillable fields and copy their exact text. " +
  "You never invent values or map text that does not appear verbatim.";

const FIELD_SUGGESTION_SPEC = `Identify the values in this document that should become fillable fields — party names, addresses, registration numbers (KRS / NIP / REGON), monetary amounts, dates, the signatory's name and role, and free-text sections such as the scope of a power of attorney.

For each, return:
- literalText: the EXACT text in the document to replace, copied verbatim
- fieldPath: a dot-separated name, e.g. company.name, company.krs, signatory.name, signatory.role, signing_date, scope. Only letters, digits, underscores, dashes and dots — for list positions use dots (attorneys.0.name), NEVER brackets
- inputType: one of text, textarea, number, boolean, date, select
- label: a short user-facing question or name for the fill form, in the document's language (e.g. "Company name")
- exampleValue: a realistic example of the value, copied or derived from the document
- aiPrompt: ONLY for free-text sections that should be drafted by AI at fill time (e.g. the scope of the power of attorney) — an instruction describing what to draft. Use null for ordinary fields.`;

// The model occasionally invents bracket-indexed paths (attorneys[0].name)
// despite the prompt; the marker grammar only knows dotted segments, and
// resolvePath walks numeric segments into arrays, so rewrite [N] -> .N and
// drop any suggestion whose path still falls outside the grammar — an invalid
// path would insert a {{marker}} nothing can highlight, discover, or fill.
const sanitizeFieldPath = (raw: string): string | null => {
  const dotted = raw
    .replaceAll(/\[(\d+)\]/gu, ".$1")
    .replaceAll(/\.{2,}/gu, ".")
    .replace(/^\./u, "")
    .replace(/\.$/u, "");
  return dotted.length > 0 && isFieldPath(dotted) ? dotted : null;
};

const buildPrompt = (documentText: string, instructions?: string): string => {
  const extra = instructions
    ? `Additional instructions from the user, follow them:\n${instructions}\n\n`
    : "";
  return `${FIELD_SUGGESTION_SPEC}\n\n${extra}Document:\n${documentText}`;
};

export const suggestTemplateFields = async ({
  documentText,
  instructions,
  orgAIConfig,
  organizationId,
}: {
  documentText: string;
  instructions?: string | undefined;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
}): Promise<FieldSuggestion[]> => {
  try {
    const result = streamText({
      abortSignal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
      messages: [
        { role: "user", content: buildPrompt(documentText, instructions) },
      ],
      model: getModelForRole("fast", orgAIConfig, {
        promptCachingEnabled: false,
        scopeKey: organizationId,
        organizationId,
        serviceTier: "standard",
      }),
      output: Output.object({
        schema: strictOutputSchema(fieldSuggestionsSchema),
      }),
      system: SYSTEM_PROMPT,
    });
    const { suggestions } = await result.output;
    // The schema models "absent" as null (OpenAI strict mode); FieldSuggestion
    // uses optional members.
    return suggestions.flatMap((s) => {
      const fieldPath = sanitizeFieldPath(s.fieldPath);
      if (fieldPath === null) {
        return [];
      }
      return [
        {
          literalText: s.literalText,
          fieldPath,
          inputType: s.inputType ?? undefined,
          label: s.label ?? undefined,
          exampleValue: s.exampleValue ?? undefined,
          aiPrompt: s.aiPrompt ?? undefined,
        },
      ];
    });
  } catch {
    return [];
  }
};
