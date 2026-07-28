/**
 * Dependent (subset) select fields.
 *
 * A manifest field with `optionsFrom` takes its allowed values from another
 * field's submitted value at fill time: the user first enters a list (an
 * `{{#each}}` array, or a single value) and the dependent field must hold one
 * of those entries. Static `options` act as a fallback while the source field
 * is empty; with neither, the value is accepted as-is.
 *
 * Pure: no IO, no model/provider dependency. The fill boundary calls
 * {@link checkDependentFields} on the incoming values (after composite
 * assembly) and rejects the request when a dependent value is outside its
 * source.
 */

import { resolvePath } from "@stll/template-conditions";

import { arrayOrEmpty } from "@/api/lib/array";
import { isRecord } from "@/api/lib/type-guards";

import { mapRepeatablePath, readRowSubPath } from "./repeatable-paths";
import type { FieldMeta } from "./types";

export type DependentFieldError = {
  /** Manifest path of the dependent field. */
  path: string;
  /** Path of the source field its options come from. */
  optionsFrom: string;
  message: string;
};

/** Collect the strings reachable at `segments`, mapping over arrays along the
 *  way so `parties.name` gathers every item's `name`. Numbers are stringified
 *  to match how number inputs compare against a select's string value. */
const collectAt = (
  current: unknown,
  segments: readonly string[],
  out: string[],
): void => {
  if (Array.isArray(current)) {
    for (const item of current) {
      collectAt(item, segments, out);
    }
    return;
  }
  const head = segments.at(0);
  if (head === undefined) {
    if (typeof current === "string" && current.trim() !== "") {
      out.push(current);
    }
    if (typeof current === "number") {
      out.push(String(current));
    }
    return;
  }
  if (!isRecord(current)) {
    return;
  }
  collectAt(current[head], segments.slice(1), out);
};

/**
 * The option values a source field currently supplies: the exact flat dotted
 * key when present (mirroring `resolvePath`), otherwise the nested walk,
 * mapping over arrays. Deduplicated, empty strings dropped.
 */
export const collectSourceValues = (
  optionsFrom: string,
  values: Record<string, unknown>,
): string[] => {
  const out: string[] = [];
  if (Object.hasOwn(values, optionsFrom)) {
    collectAt(values[optionsFrom], [], out);
  } else {
    collectAt(values, optionsFrom.split("."), out);
  }
  return [...new Set(out)];
};

/**
 * Append a dependent-field error when `value` is a non-empty string outside
 * `allowed`. Absent, empty, and non-string values are left for the fill's
 * required/unmatched diagnostics (non-strings belong to other machinery:
 * composite assembly, `#each` arrays). An empty `allowed` accepts any value
 * (the source supplied nothing and there are no static options to fall back
 * to).
 */
const checkDependentValue = ({
  value,
  allowed,
  path,
  optionsFrom,
  errors,
}: {
  value: unknown;
  allowed: readonly string[];
  path: string;
  optionsFrom: string;
  errors: DependentFieldError[];
}): void => {
  if (typeof value !== "string" || value.trim() === "") {
    return;
  }
  if (allowed.length === 0 || allowed.includes(value)) {
    return;
  }
  errors.push({
    path,
    optionsFrom,
    message:
      `Field "${path}": value "${value}" is not among ` +
      `the values of "${optionsFrom}".`,
  });
};

/**
 * Validate every dependent (optionsFrom) field's value against the source
 * field's submitted values. An absent or empty value is left for the fill's
 * required/unmatched diagnostics; non-string values belong to other machinery
 * (composite assembly, `#each` arrays) and are skipped likewise.
 *
 * A dependent select inside an `{{#each}}` group keeps a flat manifest path
 * (`people.lead`) while the fill form submits the loop as an array of rows
 * (`people: [{ name, lead }]`). A direct `resolvePath` walk into that array
 * returns `undefined` and would skip the field, so the repeatable case maps
 * the dependent path through each row (via {@link mapRepeatablePath}) and
 * validates every row's sub-path value, mirroring how `collectSourceValues`
 * already gathers `optionsFrom` across array items.
 */
export const validateDependentFields = ({
  values,
  fields,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
}): DependentFieldError[] => {
  const errors: DependentFieldError[] = [];

  for (const field of fields) {
    const source = field.optionsFrom;
    if (source === undefined) {
      continue;
    }

    const sourceValues = collectSourceValues(source, values);
    const fallbackOptions = arrayOrEmpty(field.options);
    const allowed = sourceValues.length > 0 ? sourceValues : fallbackOptions;

    const repeatable = mapRepeatablePath(
      values,
      field.path,
      ({ row, subPath }) =>
        checkDependentValue({
          value: readRowSubPath(row, subPath),
          allowed,
          path: field.path,
          optionsFrom: source,
          errors,
        }),
    );
    if (repeatable) {
      continue;
    }

    checkDependentValue({
      value: resolvePath(field.path, values),
      allowed,
      path: field.path,
      optionsFrom: source,
      errors,
    });
  }

  return errors;
};

/**
 * Boundary convenience for the fill handlers: validate dependent field values
 * and return the combined validation message, or null when every dependent
 * value is within its source (or there is no manifest).
 */
export const checkDependentFields = (
  values: Record<string, unknown>,
  manifest: { fields: FieldMeta[] } | null,
): string | null => {
  if (!manifest) {
    return null;
  }
  const errors = validateDependentFields({
    values,
    fields: manifest.fields,
  });
  if (errors.length === 0) {
    return null;
  }
  return errors.map((e) => e.message).join(" ");
};
