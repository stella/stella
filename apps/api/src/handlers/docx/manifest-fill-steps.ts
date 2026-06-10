/**
 * Shared pre-fill value pipeline for every fill boundary (web fill,
 * fill-by-id, fill-preview, and the stored-template fill service): resolve
 * registry lookups, assemble composite (multipart) values, evaluate formula
 * (derived) fields, and check dependent (optionsFrom) selects — in that
 * order, before any AI step or substitution sees the values. Formulas run
 * after lookup and composite so they can reference those results, and before
 * the dependent check so it sees the final values. Mutates `values` in place
 * and returns the first failing step's combined validation message (the
 * boundary rejects with it, naming the field), or null when everything
 * passed.
 */

import { applyCompositeFields } from "./composite-fields";
import { checkDependentFields } from "./dependent-fields";
import { applyFormulaFields } from "./formula-fields";
import {
  type AiLookupFormatter,
  applyLookupFields,
  type LookupResolver,
} from "./lookup-fields";
import type { FieldMeta } from "./types";

export const applyManifestFillSteps = async ({
  values,
  manifest,
  resolveLookup,
  formatLookupWithAi,
}: {
  values: Record<string, unknown>;
  manifest: { fields: FieldMeta[] } | null;
  resolveLookup: LookupResolver;
  /** Optional model-backed formatter for lookup fields with an aiFormat
   *  instruction; without it the deterministic rendering is used. */
  formatLookupWithAi?: AiLookupFormatter | undefined;
}): Promise<string | null> => {
  const lookupError = await applyLookupFields(values, manifest, {
    resolve: resolveLookup,
    formatWithAi: formatLookupWithAi,
  });
  if (lookupError !== null) {
    return lookupError;
  }

  const compositeError = applyCompositeFields(values, manifest);
  if (compositeError !== null) {
    return compositeError;
  }

  applyFormulaFields(values, manifest);

  return checkDependentFields(values, manifest);
};
