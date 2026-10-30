// parser-output-unchanged: [cz-ns] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [cz-nss] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [cz-us] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [cz-regional] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [sk-courts] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [sk-us] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-courts] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-sn] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-kio] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-tk] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-nsa] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-ncourt] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-courts] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-vfgh] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-vwgh] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-bvwg] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-lvwg] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-asylgh] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-ubas] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-uvs] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-verg] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-umse] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-bks] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [at-findok] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [eu-ecj] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [hu-bhgy] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-kis] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-uodo] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: [pl-uokik] shared utilities moved to parser owners with byte-identical output.
// parser-output-unchanged: Unicode owner migration retains native normalization forms, mark classes and operation order; no folding is added.
// parser-output-unchanged: SHA-256 ownership changes preserve input bytes, serialization and update order, so stored hashes and parser output remain identical.
// parser-output-unchanged: removes an unused type guard; no adapter calls it.
/** Shared utilities for case-law ingestion adapters. */

import { normalizeUnicode } from "@stll/text-normalize";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

export { INGESTION_USER_AGENT } from "@/api/lib/case-law/ingestion-user-agent";
export { stripHtml } from "@/api/handlers/case-law/ingestion/parsers/strip-html";

const CE_DATE_PATTERN =
  /^(?<day>\d{1,2})\.\s*(?<month>\d{1,2})\.\s*(?<year>\d{4})$/;

export const isArrayOf = <T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): value is T[] => Array.isArray(value) && value.every(guard);

export const isNullishString = (
  value: unknown,
): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string";

export const isNullishNumber = (
  value: unknown,
): value is number | null | undefined =>
  value === undefined || value === null || typeof value === "number";

export const isNullishValue = <T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): value is T | null | undefined =>
  value === undefined || value === null || guard(value);

export const isNullishArrayOf = <T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): value is T[] | null | undefined =>
  value === undefined || value === null || isArrayOf(value, guard);

export const toOptionalValue = <T>(
  value: T | null | undefined,
): T | undefined => value ?? undefined;

/** Derived metadata values; stated values remain in the source metadata. */
export const normalizeMetadataValues = (
  values: readonly string[] | null | undefined,
): string[] => {
  if (values === null || values === undefined) {
    return [];
  }
  const normalized = values.map((value) =>
    normalizeUnicode(value, "NFC").replaceAll(/\s+/gu, " ").trim(),
  );
  return [...new Set(normalized.filter((value) => value.length > 0))];
};

/**
 * Parse Central-European date formats to ISO "YYYY-MM-DD".
 * Accepts "D. M. YYYY" (CZ) and "DD.MM.YYYY" (SK).
 */
export const parseCeDate = (dateStr: string): string | undefined => {
  const groups = CE_DATE_PATTERN.exec(dateStr.trim())?.groups;
  if (!groups?.["day"] || !groups["month"] || !groups["year"]) {
    return undefined;
  }
  const day = groups["day"].padStart(2, "0");
  const month = groups["month"].padStart(2, "0");
  return `${groups["year"]}-${month}-${day}`;
};

/** Check if an error is a per-request timeout (not a cycle/page abort). */
export const isTimeoutError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "TimeoutError";

/**
 * Catch handler for Result.tryPromise in adapters.
 * Re-throws AdapterFetchError as-is; wraps unknown
 * errors with adapter context.
 */
export const adapterCatch =
  (adapterKey: string, cursor: string | null) =>
  (cause: unknown): AdapterFetchError => {
    if (cause instanceof AdapterFetchError) {
      return cause;
    }
    return new AdapterFetchError({
      message: cause instanceof Error ? cause.message : String(cause),
      adapterKey,
      cursor,
      cause,
    });
  };
