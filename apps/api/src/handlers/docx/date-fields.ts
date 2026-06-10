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

import { resolvePath } from "@stll/template-conditions";

import { replaceResolvedValue } from "./composite-fields";
import type { DateFormatStyle, FieldDateFormat, FieldMeta } from "./types";

export type DateFieldError = {
  /** Manifest path of the date field. */
  path: string;
  message: string;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Parse a strict YYYY-MM-DD calendar date; null when malformed or not a real
 * date. UTC-anchored so the rendered day never shifts with the server
 * timezone. `Date` rolls out-of-range components over (2028-02-30 → March
 * 1), so the round-trip comparison catches non-existent dates.
 */
const parseIsoDate = (value: string): Date | null => {
  if (!ISO_DATE_PATTERN.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(value)) {
    return null;
  }
  return date;
};

const STYLE_OPTIONS: Record<
  Exclude<DateFormatStyle, "iso">,
  Intl.DateTimeFormatOptions
> = {
  long: { dateStyle: "long" },
  medium: { dateStyle: "medium" },
  short: { dateStyle: "short" },
};

const formatStyled = (
  date: Date,
  locale: string,
  style: Exclude<DateFormatStyle, "iso">,
): string =>
  new Intl.DateTimeFormat(locale, {
    ...STYLE_OPTIONS[style],
    timeZone: "UTC",
  }).format(date);

/** Format an ISO date per the field's locale + style; null when the value is
 *  not a valid calendar date. The "iso" style returns the value unchanged. */
export const formatIsoDate = (
  value: string,
  dateFormat: FieldDateFormat,
): string | null => {
  const date = parseIsoDate(value);
  if (date === null) {
    return null;
  }
  if (dateFormat.style === "iso") {
    return value;
  }
  return formatStyled(date, dateFormat.locale, dateFormat.style);
};

/** Exemplar date for configuration previews; day > 12 so day/month order is
 *  unambiguous in every locale. */
export const DATE_FORMAT_EXAMPLE_ISO = "2028-06-13";

/** Render the exemplar date in the given locale + style — the template
 *  config UI shows this as a live preview next to the style picker. */
export const formatDateExample = (dateFormat: FieldDateFormat): string => {
  if (dateFormat.style === "iso") {
    return DATE_FORMAT_EXAMPLE_ISO;
  }
  return formatStyled(
    new Date(`${DATE_FORMAT_EXAMPLE_ISO}T00:00:00Z`),
    dateFormat.locale,
    dateFormat.style,
  );
};

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
