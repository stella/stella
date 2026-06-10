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
 * as the stub it inflects per occurrence. Mutates `values` in place and
 * returns the first failing step's combined validation message (the
 * boundary rejects with it, naming the field), or null when everything
 * passed.
 */

import { checkArrayBounds } from "./array-bounds";
import { applyCompositeFields } from "./composite-fields";
import { applyDateFields } from "./date-fields";
import { checkDependentFields } from "./dependent-fields";
import { applyFormulaFields } from "./formula-fields";
import { applyLookupFields, type LookupResolver } from "./lookup-fields";
import type { FieldMeta } from "./types";

export const applyManifestFillSteps = async ({
  values,
  manifest,
  resolveLookup,
}: {
  values: Record<string, unknown>;
  manifest: { fields: FieldMeta[] } | null;
  resolveLookup: LookupResolver;
}): Promise<string | null> => {
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

  return applyDateFields(values, manifest);
};
