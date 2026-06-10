/**
 * Client-side mirror of the fill engine's locale-aware date rendering
 * (apps/api/src/handlers/docx/date-fields.ts): the wizard previews how a
 * style renders, and the fill form previews how the entered date will appear
 * in the generated document. `Intl.DateTimeFormat` with the same style map
 * and UTC anchoring produces the identical string on both sides; Eden
 * exposes types only, so the style list is mirrored here — extend together
 * with `DATE_FORMAT_STYLES` in apps/api/src/handlers/docx/types.ts.
 */

/** Mirrors `DATE_FORMAT_STYLES` from apps/api/src/handlers/docx/types.ts. */
export const DATE_FORMAT_STYLES = ["long", "medium", "short", "iso"] as const;

export type DateFormatStyle = (typeof DATE_FORMAT_STYLES)[number];

export type TemplateDateFormat = {
  /** BCP-47 language tag of the document, e.g. "cs", "de", "pl". */
  locale: string;
  style: DateFormatStyle;
};

const STYLE_OPTIONS: Record<
  Exclude<DateFormatStyle, "iso">,
  Intl.DateTimeFormatOptions
> = {
  long: { dateStyle: "long" },
  medium: { dateStyle: "medium" },
  short: { dateStyle: "short" },
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Strict YYYY-MM-DD calendar date, UTC-anchored; the round-trip check
 *  rejects rolled-over dates (2028-02-30). Same rule the fill applies. */
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

const formatStyled = (
  date: Date,
  locale: string,
  style: Exclude<DateFormatStyle, "iso">,
): string =>
  new Intl.DateTimeFormat(locale, {
    ...STYLE_OPTIONS[style],
    timeZone: "UTC",
  }).format(date);

/** Exemplar date for configuration previews; day > 12 so day/month order is
 *  unambiguous in every locale. Mirrors `DATE_FORMAT_EXAMPLE_ISO`. */
export const DATE_FORMAT_EXAMPLE_ISO = "2028-06-13";

/** Render the exemplar date in the given locale + style; the style picker
 *  shows this so each choice is self-describing. */
export const formatDateExample = (dateFormat: TemplateDateFormat): string => {
  if (dateFormat.style === "iso") {
    return DATE_FORMAT_EXAMPLE_ISO;
  }
  return formatStyled(
    new Date(`${DATE_FORMAT_EXAMPLE_ISO}T00:00:00Z`),
    dateFormat.locale,
    dateFormat.style,
  );
};

/** Format an entered ISO date as the document will render it; null when the
 *  value is not a valid calendar date. "iso" returns the value unchanged. */
export const formatDateValue = (
  value: string,
  dateFormat: TemplateDateFormat,
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

// ── Quick-pick dates for the fill form ────────────────────

/** Local calendar date as YYYY-MM-DD (the date input's value format). */
const isoFromLocalDate = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
};

export const todayIso = (): string => isoFromLocalDate(new Date());

export const firstOfNextMonthIso = (): string => {
  const now = new Date();
  return isoFromLocalDate(new Date(now.getFullYear(), now.getMonth() + 1, 1));
};

export const inDaysIso = (days: number): string => {
  const now = new Date();
  return isoFromLocalDate(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + days),
  );
};
