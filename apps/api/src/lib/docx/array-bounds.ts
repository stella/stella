/**
 * Loop repeat-bounds enforcement.
 *
 * A loop's minimum/maximum repeats live as `validation.minItems` /
 * `validation.maxItems` on the FieldMeta whose path equals the loop's array
 * (container) path — the same path the fill form's ArrayFieldRenderer is keyed
 * by. At fill time the boundary resolves the submitted value at that path and
 * checks its length is within [minItems ?? 0, maxItems ?? ∞], rejecting with a
 * field-named message on the first violation. A missing/non-array value counts
 * as length 0, so a positive `minItems` rejects an omitted required loop —
 * except when the container field carries a boolean rule `condition`, since
 * such a loop may be legitimately suppressed and this check runs before block
 * expansion (it cannot see the document's `{{#if}}` structure). `maxItems` only
 * constrains a value that is actually an array.
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
    const isArray = Array.isArray(value);
    const length = isArray ? value.length : 0;
    const label = field.label ?? field.path;
    const min = minItems ?? 0;

    // A missing/non-array value counts as length 0, so a positive minItems
    // rejects an omitted required loop (a template that needs >= 1 repeat must
    // not render zero items). Exception: a loop gated by a boolean rule
    // `condition` on its own container field may be legitimately suppressed, so
    // its array being absent is not a violation — checkArrayBounds runs before
    // block expansion and cannot see the document's `{{#if}}` structure, so it
    // would otherwise over-reject. (It still cannot detect a loop gated by a
    // SEPARATE `{{#if}}` field; that residual case is unenforced.)
    if (min > 0 && length < min && field.condition === undefined) {
      return `Field "${label}": needs at least ${min} item(s), got ${length}.`;
    }

    // maxItems only constrains a present array; a missing value has nothing to
    // cap.
    if (isArray && maxItems !== undefined && length > maxItems) {
      return `Field "${label}": allows at most ${maxItems} item(s), got ${length}.`;
    }
  }

  return null;
};
