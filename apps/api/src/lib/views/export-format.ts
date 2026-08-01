import { Result } from "better-result";

import type { FieldContent } from "@/api/db/schema-validators";

const exportDateFormatters = new Map<string, Intl.DateTimeFormat>();

/** `Intl.DateTimeFormat` for `locale`, cached per locale (bounded by the
 *  app's supported locales) instead of rebuilt on every export row. */
const getExportDateFormatter = (locale: string): Intl.DateTimeFormat => {
  const formatter =
    exportDateFormatters.get(locale) ??
    new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  exportDateFormatters.set(locale, formatter);
  return formatter;
};

export const formatExportDate = (value: string, locale: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return getExportDateFormatter(locale).format(date);
};

const exportNumberFormatters = new Map<string, Intl.NumberFormat>();

/** `Intl.NumberFormat` for `locale` (no currency), cached per locale. */
const getExportNumberFormatter = (locale: string): Intl.NumberFormat => {
  const formatter =
    exportNumberFormatters.get(locale) ?? new Intl.NumberFormat(locale);
  exportNumberFormatters.set(locale, formatter);
  return formatter;
};

const exportCurrencyFormatters = new Map<string, Intl.NumberFormat>();

/** `Intl.NumberFormat` for `locale` + `currency`, cached per pair. Currency
 *  construction can throw on an invalid ISO code, so callers get a `Result`. */
const getExportCurrencyFormatter = (
  locale: string,
  currency: string,
): Result<Intl.NumberFormat, unknown> => {
  const key = `${locale}:${currency}`;
  const cached = exportCurrencyFormatters.get(key);
  if (cached) {
    return Result.ok(cached);
  }
  const created = Result.try(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
      }),
  );
  if (!Result.isError(created)) {
    exportCurrencyFormatters.set(key, created.value);
  }
  return created;
};

const formatExportNumber = (
  value: number,
  currency: string | null,
  locale: string,
): string => {
  if (!currency) {
    return getExportNumberFormatter(locale).format(value);
  }

  const formatter = getExportCurrencyFormatter(locale, currency);
  if (!Result.isError(formatter)) {
    return formatter.value.format(value);
  }

  return `${getExportNumberFormatter(locale).format(value)} ${currency}`;
};

export const formatFieldContent = (
  content: FieldContent | undefined,
  locale: string,
): string => {
  if (!content) {
    return "";
  }

  switch (content.type) {
    case "text":
      return content.value;
    case "file":
      return content.fileName;
    case "single-select":
      return content.value ?? "";
    case "multi-select":
      return content.value.join(", ");
    case "date":
      return content.value ? formatExportDate(content.value, locale) : "";
    case "int":
      return formatExportNumber(content.value, content.currency, locale);
    case "clip":
      return content.url;
    case "error":
      return "Error";
    case "pending":
      return "";
    case "unsupported":
      return "Unsupported";
    default:
      return "";
  }
};
