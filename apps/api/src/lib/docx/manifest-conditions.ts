/**
 * Synthesize the full named-condition list a template's `{{#if}}` markers
 * resolve against.
 *
 * A condition is just a boolean field: a boolean field with a `condition` rule
 * IS a named condition addressed by its own field path. Boolean condition-fields
 * (`inputType === "boolean"` with a non-empty `condition`) are surfaced as
 * `{ name: path, expression: condition, label }`.
 *
 * The result feeds `evaluateCondition` everywhere a marker may reference a
 * condition by name, so `{{#if field_path}}` resolves the field's rule with no
 * evaluator change.
 */

import type { NamedCondition } from "@stll/template-conditions";

import type { FieldMeta, TemplateManifest } from "./types";

/**
 * Identifies a boolean condition-field: a boolean field whose value is derived
 * by a non-empty rule, held either as a `{{#if}}` string (`condition`) or, for
 * formula-bearing rules, as the AST (`conditionAst`). The web/Studio side
 * mirrors this exact predicate.
 */
const isConditionField = (field: FieldMeta): boolean =>
  field.inputType === "boolean" &&
  ((field.condition !== undefined && field.condition !== "") ||
    field.conditionAst !== undefined);

/**
 * Build the `NamedCondition[]` from the boolean condition-fields in the
 * manifest. An AST-backed rule carries its `node` (evaluated directly); a
 * string-backed rule carries its `expression`.
 */
export const manifestNamedConditions = (
  manifest: TemplateManifest,
): NamedCondition[] => {
  const byName = new Map<string, NamedCondition>();
  for (const field of manifest.fields) {
    if (!isConditionField(field)) {
      continue;
    }
    const named: NamedCondition = {
      name: field.path,
      expression: field.condition ?? "",
    };
    if (field.conditionAst !== undefined) {
      named.node = field.conditionAst;
    }
    if (field.label !== undefined) {
      named.label = field.label;
    }
    byName.set(field.path, named);
  }
  return [...byName.values()];
};
