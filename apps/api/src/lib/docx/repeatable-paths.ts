/**
 * Array-aware resolution for dotted field paths inside `{{#each}}` loops.
 *
 * A field placed inside a repeatable group keeps a flat manifest path like
 * `people.dob` (the date sub-field) or `parties.signer` (a composite), while
 * the fill form submits the loop as an array of row objects, e.g.
 * `people: [{ dob }]` or `parties: [{ signer: { title, name } }]`. The
 * deterministic fill steps (date-fields, composite-fields) resolve the dotted
 * path directly against the top-level values map; that lookup walks into the
 * array and returns `undefined`, so the per-row value is never transformed and
 * the loop expander later substitutes the raw value.
 *
 * {@link mapRepeatablePath} bridges that gap: take the shortest dotted prefix
 * of the path that resolves to an array (so a nested container like
 * `deal.parties` is found, not the `deal` object) as the container path, with
 * the remainder as the item-relative sub-path, and run a per-row callback
 * against each item's sub-path value, writing the transformed value back into
 * the row in place.
 * The loop expander's `registerItemPatchValues` then flattens the rewritten
 * row value under `__each_<container>_<idx>_<subPath>`.
 *
 * Pure: no IO, no model/provider dependency.
 */

import { resolvePath } from "@stll/template-conditions";

import { isRecord } from "@/api/lib/type-guards";

/** Outcome of {@link mapRepeatablePath}: whether the path was a repeatable
 *  (array-container) path and was iterated. `false` means the caller should
 *  fall back to its non-repeatable handling. */
export type RepeatableMapped = boolean;

/** The array container a repeatable dotted path resolves against: the
 *  container's own path, the item-relative sub-path within each row, and the
 *  row values exactly as submitted — unfiltered, so a caller decides for
 *  itself how to treat a row that is not an object (skip it, as
 *  {@link mapRepeatablePath}'s transform callers do, or treat it as invalid,
 *  as a required-field check must). */
export type RepeatableContainer = {
  containerPath: string;
  subPath: string;
  rows: readonly unknown[];
};

/**
 * Find the array container a dotted path resolves against in `values`: the
 * shortest dotted prefix of `path` that resolves to an array (so a loop over
 * a nested array — `{{#each deal.parties}}` for the field path
 * `deal.parties.dob` — finds the `deal.parties` array, not the `deal`
 * object; `resolvePath` cannot index into an array, so at most one prefix
 * resolves to one). Returns `null` when `path` has no dot, or no prefix
 * resolves to an array — the caller then falls back to its non-repeatable
 * handling.
 */
export const findRepeatableContainer = (
  values: Record<string, unknown>,
  path: string,
): RepeatableContainer | null => {
  const segments = path.split(".");
  if (segments.length < 2) {
    return null;
  }
  for (let cut = 1; cut < segments.length; cut += 1) {
    const containerPath = segments.slice(0, cut).join(".");
    const container = resolvePath(containerPath, values);
    if (!Array.isArray(container)) {
      continue;
    }
    return {
      containerPath,
      subPath: segments.slice(cut).join("."),
      rows: container,
    };
  }
  return null;
};

/**
 * When `path` is a dotted path whose container segment resolves to an array
 * in `values`, run `mapRow` for each row and return true. Otherwise (the
 * container is absent or not an array, or the path has no dot) return false so
 * the caller keeps its existing single-value handling.
 *
 * `mapRow` receives the row object, the item-relative sub-path (everything
 * after the first dot), the row's index in the container array, and the
 * container path; it reads the current sub-path value (via
 * {@link readRowSubPath}) and writes the transformed value back into the row
 * in place (via {@link writeRowSubPath}). Rows that are not objects are skipped
 * (left for the fill's unmatched diagnostics), matching the single-value steps'
 * tolerance of absent values.
 */
export const mapRepeatablePath = (
  values: Record<string, unknown>,
  path: string,
  mapRow: (args: {
    row: Record<string, unknown>;
    subPath: string;
    index: number;
    containerPath: string;
  }) => void,
): RepeatableMapped => {
  const found = findRepeatableContainer(values, path);
  if (found === null) {
    return false;
  }
  const { containerPath, subPath, rows } = found;
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      continue;
    }
    mapRow({ row, subPath, index, containerPath });
  }
  return true;
};

/** Read an item-relative sub-path (e.g. `signer.title`) within a row object,
 *  honoring both a flat dotted key and nested segments — the same dual shape
 *  {@link resolvePath} resolves at the top level. */
export const readRowSubPath = (
  row: Record<string, unknown>,
  subPath: string,
): unknown => resolvePath(subPath, row);

/** Write `value` at the item-relative `subPath` within a row object, replacing
 *  the value where {@link readRowSubPath} found it: the exact flat dotted key
 *  when present, otherwise the nested leaf. Mirrors `replaceResolvedValue` but
 *  scoped to a single loop row. */
export const writeRowSubPath = (
  row: Record<string, unknown>,
  subPath: string,
  value: unknown,
): void => {
  if (Object.hasOwn(row, subPath)) {
    row[subPath] = value;
    return;
  }
  const segments = subPath.split(".");
  let current: Record<string, unknown> = row;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) {
    current[leaf] = value;
  }
};
