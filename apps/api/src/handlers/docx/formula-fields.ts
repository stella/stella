/**
 * Formula (derived) fields.
 *
 * A manifest field with a `formula` takes its value from an arithmetic
 * expression over the other submitted values at fill time, e.g.
 * `min(rent * (1 + index / 100), rent * 1.05)`. The expression language is
 * the shared `evaluateNumericExpression` evaluator from
 * `@stll/template-conditions` (dotted-path variables, `+ - * / %`, `min`,
 * `max`, `round`, `abs`, `floor`, `ceil`).
 *
 * Formula fields are derived, never user-submitted: any submitted value for
 * one is dropped before evaluation so it cannot pose as the derived result.
 * Fields are evaluated in declaration order, so a formula may reference an
 * earlier formula field. A malformed or non-numeric expression resolves to
 * `undefined` and the field is left unfilled (it then surfaces in the fill's
 * unmatched-placeholder diagnostics rather than rendering `NaN`).
 *
 * Pure: no IO, no model/provider dependency. The fill boundary calls
 * {@link applyFormulaFields} after lookup resolution and composite assembly
 * (so a formula can reference their results) and before the dependent-field
 * check and any AI step.
 */

import { evaluateNumericExpression } from "@stll/template-conditions";

import { isRecord } from "@/api/lib/type-guards";

import type { FieldMeta } from "./types";

/** Remove the value at `path` where `resolvePath` would find it: the exact
 *  flat dotted key when present, otherwise the nested leaf. */
const deleteSubmittedValue = (
  values: Record<string, unknown>,
  path: string,
): void => {
  if (Object.hasOwn(values, path)) {
    Reflect.deleteProperty(values, path);
    return;
  }
  const segments = path.split(".");
  let current: Record<string, unknown> = values;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) {
    Reflect.deleteProperty(current, leaf);
  }
};

/**
 * Evaluate every formula field's expression against the submitted values and
 * write the results in (as strings, under the field's flat dotted path, which
 * both block directives and `{{...}}` substitution resolve). Mutates `values`
 * in place; submitted values for formula fields are dropped first.
 */
export const resolveFormulaFields = ({
  values,
  fields,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
}): void => {
  for (const field of fields) {
    if (field.formula === undefined) {
      continue;
    }
    deleteSubmittedValue(values, field.path);
    const result = evaluateNumericExpression(field.formula, values);
    if (result !== undefined) {
      values[field.path] = String(result);
    }
  }
};

/**
 * Boundary convenience for the fill handlers: evaluate formula fields in
 * place. No-op without a manifest; never fails the request (a malformed
 * expression just leaves its field unfilled).
 */
export const applyFormulaFields = (
  values: Record<string, unknown>,
  manifest: { fields: FieldMeta[] } | null,
): void => {
  if (!manifest) {
    return;
  }
  resolveFormulaFields({ values, fields: manifest.fields });
};
