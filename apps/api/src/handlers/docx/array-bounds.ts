/**
 * Loop repeat-bounds enforcement.
 *
 * A loop's minimum/maximum repeats live as `validation.minItems` /
 * `validation.maxItems` on the FieldMeta whose path equals the loop's array
 * (container) path — the same path the fill form's ArrayFieldRenderer is keyed
 * by. At fill time the boundary resolves the submitted value at that path and,
 * when it is an array, checks its length is within [minItems ?? 0, maxItems ??
 * ∞], rejecting with a field-named message on the first violation.
 *
 * Pure: no IO, no model/provider dependency. Wired into the shared
 * `applyManifestFillSteps` pipeline so every fill boundary enforces it.
 */

import { resolvePath } from "@stll/template-conditions";

import type { FieldMeta } from "./types";

/**
 * Validate every loop-container field's submitted array length against its
 * `minItems`/`maxItems` bounds. Returns a user-facing message naming the field
 * on the first violation, or null when every bounded loop is within range (or
 * there is no manifest).
 */
export const checkArrayBounds = (
  values: Record<string, unknown>,
  manifest: { fields: FieldMeta[] } | null,
): string | null => {
  if (!manifest) {
    return null;
  }

  for (const field of manifest.fields) {
    const { minItems, maxItems } = field.validation ?? {};
    if (minItems === undefined && maxItems === undefined) {
      continue;
    }

    const value = resolvePath(field.path, values);
    if (!Array.isArray(value)) {
      continue;
    }

    const label = field.label ?? field.path;
    const min = minItems ?? 0;
    if (value.length < min) {
      return `Field "${label}": needs at least ${min} item(s), got ${value.length}.`;
    }
    if (maxItems !== undefined && value.length > maxItems) {
      return `Field "${label}": allows at most ${maxItems} item(s), got ${value.length}.`;
    }
  }

  return null;
};
