/**
 * Shared pre-fill value pipeline for every fill boundary (web fill,
 * fill-by-id, fill-preview, and the stored-template fill service): resolve
 * registry lookups, assemble composite (multipart) values, evaluate formula
 * (derived) fields, check dependent (optionsFrom) selects, and format date
 * fields — in that order, before any AI step or substitution sees the
 * values. Formulas run after lookup and composite so they can reference
 * those results, and before the dependent check so it sees the final
 * values. Date formatting runs last so the AI-adaptation step (which every
 * boundary applies after this pipeline) receives the locale-rendered date
 * as the stub it inflects per occurrence. Just before that, each date
 * field's raw ISO value is stashed on the map (under CONDITION_RAW_VALUES)
 * so a date both formatted and referenced by a `{{#if}}` still compares as
 * an ISO date in `fillTemplate`, not as the localized display text. Mutates
 * `values` in place and returns the first failing step's combined
 * validation message (the boundary rejects with it, naming the field), or
 * null when everything passed.
 */

import { resolvePath } from "@stll/template-conditions";

import type { BindingContext } from "@/api/lib/template-binding/apply-source-fields";
import {
  applySourceFields,
  EMPTY_BINDING_CONTEXT,
} from "@/api/lib/template-binding/apply-source-fields";

import { checkArrayBounds } from "./array-bounds";
import { CONDITION_RAW_VALUES } from "./block-directives";
import { applyCompositeFields } from "./composite-fields";
import { applyDateFields } from "./date-fields";
import { checkDependentFields } from "./dependent-fields";
import { applyFormulaFields } from "./formula-fields";
import { applyLookupFields, type LookupResolver } from "./lookup-fields";
import { mapRepeatablePath, readRowSubPath } from "./repeatable-paths";
import type { FieldMeta } from "./types";

/**
 * Capture each date field's raw ISO value (the submitted `YYYY-MM-DD`, still
 * intact at this point in the pipeline) under {@link CONDITION_RAW_VALUES} on
 * the values map, keyed by field path. `applyDateFields` then rewrites those
 * paths in `values` to localized display text for substitution; the stashed
 * overlay lets `{{#if dateField > "2028-01-01"}}` conditions in `fillTemplate`
 * compare the ISO value instead of the display string. Non-string or empty
 * values are skipped (nothing to compare, and `applyDateFields` reports the
 * malformed ones). No-op when the manifest declares no formatted date fields.
 *
 * A date field inside an `{{#each}}` loop keeps a dotted path (`people.dob`)
 * while the value is an array of rows; its raw ISO is stashed per row under an
 * index-qualified key (`people.0.dob`) so a top-level
 * `{{#if people.0.dob > "..."}}` compares the ISO value, and the loop expander
 * overlays the same raw value as the bare sub-path in each row's condition
 * context (see `applyRowRawOverlay` in block-directives) so a condition
 * referencing the field from *inside* the loop body, `{{#if dob > "..."}}`,
 * compares the ISO value too.
 */
const stashRawDateValues = (
  values: Record<string, unknown>,
  fields: readonly FieldMeta[],
): void => {
  const rawDates: Record<string, string> = {};
  for (const field of fields) {
    if (field.inputType !== "date" || field.dateFormat === undefined) {
      continue;
    }
    const incoming = resolvePath(field.path, values);
    if (incoming === undefined) {
      mapRepeatablePath(
        values,
        field.path,
        ({ row, subPath, index, containerPath }) => {
          const raw = readRowSubPath(row, subPath);
          if (typeof raw === "string" && raw.trim() !== "") {
            rawDates[`${containerPath}.${index}.${subPath}`] = raw;
          }
        },
      );
      continue;
    }
    if (typeof incoming === "string" && incoming.trim() !== "") {
      rawDates[field.path] = incoming;
    }
  }
  if (Object.keys(rawDates).length > 0) {
    Reflect.set(values, CONDITION_RAW_VALUES, rawDates);
  }
};

export const applyManifestFillSteps = async ({
  values,
  manifest,
  resolveLookup,
  bindingContext,
}: {
  values: Record<string, unknown>;
  manifest: { fields: FieldMeta[] } | null;
  resolveLookup: LookupResolver;
  bindingContext?: BindingContext | null | undefined;
}): Promise<string | null> => {
  // Data-bound fields resolve first so the composite, formula, dependent
  // select, condition, and date-format steps below all see the filled values.
  applySourceFields(values, manifest, bindingContext ?? EMPTY_BINDING_CONTEXT);

  const lookupError = await applyLookupFields(values, manifest, {
    resolve: resolveLookup,
  });
  if (lookupError !== null) {
    return lookupError;
  }

  const compositeError = applyCompositeFields(values, manifest);
  if (compositeError !== null) {
    return compositeError;
  }

  applyFormulaFields(values, manifest);

  const dependentError = checkDependentFields(values, manifest);
  if (dependentError !== null) {
    return dependentError;
  }

  const arrayBoundsError = checkArrayBounds(values, manifest);
  if (arrayBoundsError !== null) {
    return arrayBoundsError;
  }

  // Capture raw ISO dates before applyDateFields overwrites them with display
  // text, so a date field referenced by a condition compares raw (see
  // stashRawDateValues / CONDITION_RAW_VALUES).
  if (manifest) {
    stashRawDateValues(values, manifest.fields);
  }

  return applyDateFields(values, manifest);
};
