/**
 * Date helpers for the template wizard and fill form.
 *
 * The locale-aware date RENDERING (style map, UTC anchoring, "iso"
 * passthrough) is single-sourced in @stll/template-conditions
 * (`formatDate`) — the SAME function the API fill engine renders through, so
 * the preview and the generated document are byte-identical. This module only
 * adds the web-only quick-pick date helpers and the config-preview exemplar.
 */

import {
  DATE_FORMAT_EXAMPLE_ISO,
  DATE_FORMAT_STYLES,
  formatDate,
  type FieldDateFormat,
} from "@stll/template-conditions";

export { DATE_FORMAT_EXAMPLE_ISO, DATE_FORMAT_STYLES };

export type TemplateDateFormat = FieldDateFormat;

/** Render the exemplar date in the given locale + style; the style picker
 *  shows this so each choice is self-describing. */
export const formatDateExample = (dateFormat: TemplateDateFormat): string =>
  formatDate(DATE_FORMAT_EXAMPLE_ISO, dateFormat) ?? DATE_FORMAT_EXAMPLE_ISO;

/** Format an entered ISO date as the document will render it; null when the
 *  value is not a valid calendar date. "iso" returns the value unchanged.
 *  Re-exported from the shared package so the preview cannot drift from the
 *  fill engine. */
export const formatDateValue = formatDate;

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
