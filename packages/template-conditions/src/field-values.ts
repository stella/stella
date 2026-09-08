/**
 * Single source of truth for the DETERMINISTIC field-value transforms a
 * template fill applies: formula (arithmetic over the other values) and
 * locale-aware date rendering.
 *
 * Both the API fill engine (apps/api/src/handlers/docx) and the web live
 * preview (template-studio.tsx) MUST route their rendering through
 * {@link renderDeterministicFieldValue} so the preview and the generated
 * document produce byte-identical strings. The api/field-value-parity.test.ts
 * asserts this; reintroducing a bespoke transform on either side fails CI.
 *
 * Out of scope (non-deterministic / server-only, handled by callers):
 *   - registry lookup (needs a network hit; the preview overlays it async)
 *   - AI drafting / adaptation
 *
 * Pure: no IO, no model/provider dependency. The config types here are minimal
 * STRUCTURAL shapes so the package stays free of api/web imports; callers pass
 * their own field objects, which structurally satisfy these.
 */

import { evaluateNumericExpression } from "./compute.js";
import { resolvePath } from "./path.js";

// ── Date ──────────────────────────────────────────────────

export const DATE_FORMAT_STYLES = ["long", "medium", "short", "iso"] as const;

export type DateFormatStyle = (typeof DATE_FORMAT_STYLES)[number];

/** Stable exemplar for date-format configuration previews. */
export const DATE_FORMAT_EXAMPLE_ISO = "2028-06-13";

/** Locale-aware date rendering config. "iso" leaves the submitted value as-is;
 *  the other styles map to `Intl.DateTimeFormat` `dateStyle`. */
export type FieldDateFormat = {
  /** BCP-47 language tag of the document, e.g. "cs", "de", "pl". */
  locale: string;
  style: DateFormatStyle;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const STYLE_OPTIONS: Record<
  Exclude<FieldDateFormat["style"], "iso">,
  Intl.DateTimeFormatOptions
> = {
  long: { dateStyle: "long" },
  medium: { dateStyle: "medium" },
  short: { dateStyle: "short" },
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** `Intl.DateTimeFormat` for a locale + style pair, cached per pair so it
 *  isn't rebuilt on every {@link formatDate} call. */
const getDateFormatter = (
  locale: string,
  style: Exclude<FieldDateFormat["style"], "iso">,
): Intl.DateTimeFormat => {
  const key = `${locale}:${style}`;
  const cached = dateFormatters.get(key);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat(locale, {
    ...STYLE_OPTIONS[style],
    timeZone: "UTC",
  });
  dateFormatters.set(key, formatter);
  return formatter;
};

/**
 * Parse a strict YYYY-MM-DD calendar date; null when malformed or not a real
 * date. UTC-anchored so the rendered day never shifts with the timezone.
 * `Date` rolls out-of-range components over (2028-02-30 → March 1), so the
 * round-trip comparison catches non-existent dates.
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

/**
 * Format an ISO date (YYYY-MM-DD) per the field's locale + style via
 * `Intl.DateTimeFormat` — ICU produces the correct localized (and, in date
 * contexts, correctly inflected) month names, e.g. cs long → "13. června
 * 2028". The "iso" style returns the value unchanged; an invalid calendar date
 * returns null.
 */
export const formatDate = (
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
  return getDateFormatter(dateFormat.locale, dateFormat.style).format(date);
};

// ── Dispatcher ────────────────────────────────────────────

/**
 * Minimal STRUCTURAL config of a field, carrying only what the deterministic
 * transforms read. Callers (api FieldMeta, web StudioField) structurally
 * satisfy this; lookup/AI/scalar concerns are intentionally absent because the
 * dispatcher does not handle them.
 */
export type DeterministicFieldConfig = {
  path: string;
  inputType?: string | undefined;
  formula?: string | undefined;
  dateFormat?: FieldDateFormat | undefined;
};

/**
 * THE deterministic field-value dispatcher: returns the string the fill engine
 * writes for `field` given the submitted `values`, or null when the field has
 * no deterministic transform (a scalar, lookup, or AI field the CALLER renders
 * itself).
 *
 * Dispatch order mirrors the API fill pipeline (formula → date):
 *   - formula present → {@link evaluateNumericExpression}, stringified
 *   - else date (inputType "date" + dateFormat) → {@link formatDate}
 *   - else null
 *
 * Formula and date return null when the expression or value does not yield a
 * value, so the caller leaves the field as-is.
 */
export const renderDeterministicFieldValue = (
  field: DeterministicFieldConfig,
  values: Record<string, unknown>,
): string | null => {
  if (field.formula !== undefined) {
    const result = evaluateNumericExpression(field.formula, values);
    return result === undefined ? null : String(result);
  }

  if (field.inputType === "date" && field.dateFormat !== undefined) {
    const raw = resolvePath(field.path, values);
    if (typeof raw !== "string" || raw.trim() === "") {
      return null;
    }
    return formatDate(raw, field.dateFormat);
  }

  return null;
};
