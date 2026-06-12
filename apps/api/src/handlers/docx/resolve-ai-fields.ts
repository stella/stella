/**
 * Resolve AI-fillable template fields.
 *
 * A manifest field with an `aiPrompt` has its value drafted by a model at fill
 * time (e.g. "the scope of this power of attorney"). This mirrors formula
 * fields, but the value comes from an injected generator rather than
 * arithmetic — keeping this module free of any model/provider dependency so it
 * stays pure and testable. The fill boundary supplies the generator (wired to
 * the org's model); with no generator, AI fields are left unfilled.
 *
 * A value the user actually supplied always wins over the AI draft.
 */

import { resolvePath } from "@stll/template-conditions";

import type { FieldMeta } from "./types";

export type AiFieldGenerator = (input: {
  prompt: string;
  fieldPath: string;
  /** Already-entered + previously-resolved values, for grounding the draft. */
  values: Record<string, unknown>;
  /** Rendered document text, supplied only for fields that opted in via
   *  {@link FieldMeta.aiSeesDocument}; undefined keeps the prompt unchanged. */
  documentText?: string | undefined;
}) => Promise<string | undefined>;

export const resolveAiFields = async ({
  values,
  fields,
  generate,
  documentText,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
  generate: AiFieldGenerator | undefined;
  /** Rendered document body, injected into the generator prompt only for
   *  fields with {@link FieldMeta.aiSeesDocument} set. */
  documentText?: string | undefined;
}): Promise<Record<string, unknown>> => {
  // A boolean field with an aiPrompt is a yes/no decision, not a string draft;
  // it is resolved to a real boolean by resolveAiConditions instead, so it is
  // excluded here.
  const aiFields = fields.filter(
    (field) =>
      field.aiPrompt !== undefined &&
      field.aiPrompt !== "" &&
      field.inputType !== "boolean",
  );
  if (generate === undefined || aiFields.length === 0) {
    return values;
  }

  const resolved: Record<string, unknown> = { ...values };
  for (const field of aiFields) {
    // The fill form nests dotted paths (`company.name` -> `{ company: { name }}`),
    // so resolve the path rather than reading the flat key — otherwise a nested
    // user value is missed and the AI draft overwrites it.
    const existing = resolvePath(field.path, resolved);
    if (existing !== undefined && existing !== "") {
      continue; // user-entered value wins
    }
    const prompt = field.aiPrompt;
    if (prompt === undefined) {
      continue;
    }
    const value = await generate({
      prompt,
      fieldPath: field.path,
      values: resolved,
      // Only opted-in fields pay the token cost of the document context; the
      // generator omits the section entirely when this is undefined.
      documentText: field.aiSeesDocument === true ? documentText : undefined,
    });
    if (value !== undefined) {
      resolved[field.path] = value;
    }
  }
  return resolved;
};
