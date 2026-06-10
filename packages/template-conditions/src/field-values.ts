/**
 * Single source of truth for the DETERMINISTIC field-value transforms a
 * template fill applies — composite (parts joined by a `{{key}}` format),
 * formula (arithmetic over the other values), and locale-aware date rendering.
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
import { markerPattern } from "./markers.js";
import { resolvePath } from "./path.js";

// ── Date ──────────────────────────────────────────────────

/** Locale-aware date rendering config. "iso" leaves the submitted value as-is;
 *  the other styles map to `Intl.DateTimeFormat` `dateStyle`. */
export type FieldDateFormat = {
  /** BCP-47 language tag of the document, e.g. "cs", "de", "pl". */
  locale: string;
  style: "long" | "medium" | "short" | "iso";
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
  return new Intl.DateTimeFormat(dateFormat.locale, {
    ...STYLE_OPTIONS[dateFormat.style],
    timeZone: "UTC",
  }).format(date);
};

// ── Composite ─────────────────────────────────────────────

/** Minimal structural shape of one composite field part: only the `key`
 *  referenced by the join format is needed to render. Callers' richer part
 *  types (api FieldPart, web EditablePart) structurally satisfy this. */
export type PartConfig = {
  key: string;
};

/**
 * Render a `{{key}}` format over part values. Markers whose key has no part
 * value are left as-is (a visible authoring artifact, not a render error), so
 * a partially filled composite previews exactly as the fill engine renders it.
 */
export const renderComposite = (
  parts: readonly PartConfig[],
  format: string,
  partValues: Readonly<Record<string, string>>,
): string =>
  format.replace(markerPattern(), (raw, inner: string) => {
    const key = inner.trim();
    if (!parts.some((part) => part.key === key)) {
      return raw;
    }
    return partValues[key] ?? raw;
  });

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
  parts?: readonly PartConfig[] | undefined;
  format?: string | undefined;
  formula?: string | undefined;
  dateFormat?: FieldDateFormat | undefined;
};

/** A plain object of part values: a non-null, non-array object. The api
 *  composite step accepts exactly this shape (an array or primitive is not a
 *  part-values object), so the dispatcher mirrors it. */
const isPartValuesObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Build the `{{key}} → value` map for a composite field from its raw object
 *  value, keeping only string part values for declared part keys. */
const compositePartValues = (
  parts: readonly PartConfig[],
  raw: Record<string, unknown>,
): Record<string, string> => {
  const partValues: Record<string, string> = {};
  for (const part of parts) {
    const value = raw[part.key];
    if (typeof value === "string") {
      partValues[part.key] = value;
    }
  }
  return partValues;
};

/**
 * THE deterministic field-value dispatcher: returns the string the fill engine
 * writes for `field` given the submitted `values`, or null when the field has
 * no deterministic transform (a scalar, lookup, or AI field the CALLER renders
 * itself).
 *
 * Dispatch order mirrors the API fill pipeline (composite → formula → date):
 *   - composite (parts + format present) → {@link renderComposite}
 *   - else formula present → {@link evaluateNumericExpression}, stringified
 *   - else date (inputType "date" + dateFormat) → {@link formatDate}
 *   - else null
 *
 * Composite returns null when its value is not an object of part values (a
 * plain string passes through unchanged on the api side, so the caller's
 * scalar path handles it). Formula and date return null when the expression /
 * value does not yield a value, so the caller leaves the field as-is.
 */
export const renderDeterministicFieldValue = (
  field: DeterministicFieldConfig,
  values: Record<string, unknown>,
): string | null => {
  if (field.parts !== undefined && field.format !== undefined) {
    const raw = resolvePath(field.path, values);
    if (!isPartValuesObject(raw)) {
      return null;
    }
    return renderComposite(
      field.parts,
      field.format,
      compositePartValues(field.parts, raw),
    );
  }

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
