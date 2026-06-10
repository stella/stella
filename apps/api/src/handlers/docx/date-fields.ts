/**
 * Locale-aware date field formatting.
 *
 * A manifest field with `inputType: "date"` and a `dateFormat` is submitted
 * as an ISO date (YYYY-MM-DD, the date input's value) and rendered into the
 * document in the document's language via `Intl.DateTimeFormat` — no
 * hand-rolled month-name tables; ICU produces the correct localized (and, in
 * date contexts, correctly inflected) month names, e.g. cs long →
 * "13. června 2028". The "iso" style passes the validated value through
 * unchanged.
 *
 * Runs last among the deterministic fill steps (after lookup, composite,
 * formula, and the dependent check; see manifest-fill-steps.ts) and before
 * any AI step, so a field that also sets `aiAdapt` hands the *formatted*
 * date to the per-occurrence adapter as the stub. Deeper inflection beyond
 * the standard date case (cs "k 13. červnu", "s 13. červnem") is not
 * rule-based; it composes with aiAdapt exactly through that ordering.
 *
 * Pure: no IO, no model/provider dependency.
 */

import { formatDate, resolvePath } from "@stll/template-conditions";

import { replaceResolvedValue } from "./composite-fields";
import type { FieldDateFormat, FieldMeta } from "./types";

export type DateFieldError = {
  /** Manifest path of the date field. */
  path: string;
  message: string;
};

/** Format an ISO date per the field's locale + style; null when the value is
 *  not a valid calendar date. The "iso" style returns the value unchanged.
 *  Thin wrapper over the canonical `formatDate` in @stll/template-conditions
 *  so the api fill engine and the web preview share ONE implementation; keep
 *  the name for existing importers. */
export const formatIsoDate = (
  value: string,
  dateFormat: FieldDateFormat,
): string | null => formatDate(value, dateFormat);

/** Exemplar date for configuration previews; day > 12 so day/month order is
 *  unambiguous in every locale. */
export const DATE_FORMAT_EXAMPLE_ISO = "2028-06-13";

/** Render the exemplar date in the given locale + style — the template
 *  config UI shows this as a live preview next to the style picker. */
export const formatDateExample = (dateFormat: FieldDateFormat): string =>
  formatDate(DATE_FORMAT_EXAMPLE_ISO, dateFormat) ?? DATE_FORMAT_EXAMPLE_ISO;

/**
 * Format every date field's submitted ISO value per its `dateFormat`,
 * replacing the value where `resolvePath` found it (flat dotted key or
 * nested leaf). Mutates `values` in place. An absent or empty value is left
 * for the fill's unmatched diagnostics; a malformed one is an error naming
 * the field.
 */
export const resolveDateFields = ({
  values,
  fields,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
}): DateFieldError[] => {
  const errors: DateFieldError[] = [];

  for (const field of fields) {
    if (field.inputType !== "date" || field.dateFormat === undefined) {
      continue;
    }
    const incoming = resolvePath(field.path, values);
    if (incoming === undefined) {
      continue;
    }
    if (typeof incoming !== "string") {
      errors.push({
        path: field.path,
        message: `Field "${field.path}": expected an ISO date (YYYY-MM-DD).`,
      });
      continue;
    }
    if (incoming.trim() === "") {
      continue;
    }
    const formatted = formatIsoDate(incoming, field.dateFormat);
    if (formatted === null) {
      errors.push({
        path: field.path,
        message:
          `Field "${field.path}": "${incoming}" is not a valid date ` +
          "(expected YYYY-MM-DD).",
      });
      continue;
    }
    replaceResolvedValue(values, field.path, formatted);
  }

  return errors;
};

/**
 * Boundary convenience for the fill handlers: format date values in place
 * and return the combined validation message, or null when everything
 * formatted (or there is no manifest).
 */
export const applyDateFields = (
  values: Record<string, unknown>,
  manifest: { fields: FieldMeta[] } | null,
): string | null => {
  if (!manifest) {
    return null;
  }
  const errors = resolveDateFields({ values, fields: manifest.fields });
  if (errors.length > 0) {
    return errors.map((e) => e.message).join(" ");
  }
  return null;
};
