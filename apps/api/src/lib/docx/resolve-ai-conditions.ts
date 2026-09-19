/**
 * Resolve AI-decided boolean fields.
 *
 * A boolean manifest field with an `aiPrompt` is a yes/no question the model
 * answers at fill time (e.g. "Is this a consumer contract?"). Its value must be
 * a real boolean so the `{% if field_path %}` block that references it includes
 * or excludes its content correctly.
 *
 * Mirrors `resolveAiFields` (string drafts): this module stays free of any
 * model/provider dependency so it is pure and testable. The fill boundary
 * injects the decider (wired to the org's model); with no decider the field is
 * left unset, so the referencing `{% if %}` is falsy and the block is excluded —
 * the correct default. A value the user actually supplied always wins.
 */

import { resolvePath } from "@stll/template-conditions";

import { omitSourceBoundValues } from "./ai-visible-values";
import type { FieldMeta } from "./types";

/**
 * A field the model decides: a boolean whose `aiPrompt` is the yes/no question
 * it answers. The fill decides exactly these, and so does the fill form's
 * preview of them, which is why the two share this predicate instead of
 * mirroring it.
 */
export const isAiConditionField = (
  field: FieldMeta,
): field is FieldMeta & { aiPrompt: string } =>
  field.inputType === "boolean" &&
  field.aiPrompt !== undefined &&
  field.aiPrompt !== "";

export type AiConditionDecider = (input: {
  prompt: string;
  fieldPath: string;
  /** Already-entered + previously-resolved values, for grounding the decision. */
  values: Record<string, unknown>;
}) => Promise<boolean | undefined>;

export const resolveAiConditions = async ({
  values,
  fields,
  decide,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
  decide: AiConditionDecider | undefined;
}): Promise<Record<string, unknown>> => {
  const aiConditionFields = fields.filter(isAiConditionField);
  if (decide === undefined || aiConditionFields.length === 0) {
    return values;
  }

  const resolved: Record<string, unknown> = { ...values };
  for (const field of aiConditionFields) {
    // The fill form nests dotted paths, so resolve the path rather than reading
    // the flat key — otherwise a nested user value is missed (same reasoning as
    // resolveAiFields).
    const existing = resolvePath(field.path, resolved);
    if (existing !== undefined && existing !== "") {
      continue; // user-entered value wins
    }
    const value = await decide({
      prompt: field.aiPrompt,
      fieldPath: field.path,
      values: omitSourceBoundValues({ values: resolved, fields }),
    });
    if (value !== undefined) {
      resolved[field.path] = value;
    }
  }
  return resolved;
};
