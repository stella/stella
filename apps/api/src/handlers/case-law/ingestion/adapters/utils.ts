/** Shared utilities for case-law ingestion adapters. */

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/**
 * User-Agent sent on all court website requests.
 *
 * Configurable via INGESTION_USER_AGENT env var so forks don't
 * accidentally identify as the upstream project.
 */
export const INGESTION_USER_AGENT =
  process.env["INGESTION_USER_AGENT"] ?? "Mozilla/5.0 (compatible)";

const CE_DATE_PATTERN = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/u;

/** SHA-256 content hash via Bun.CryptoHasher. */
export const hashContent = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
};

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

export const isNullishOneOrArrayOf = <T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): value is T | T[] | null | undefined =>
  value === undefined ||
  value === null ||
  guard(value) ||
  isArrayOf(value, guard);

export const toOptionalValue = <T>(
  value: T | null | undefined,
): T | undefined => value ?? undefined;

/**
 * Strip HTML tags, decode common entities (including numeric
 * &#xNN; and &#NNNN; forms), and collapse excessive newlines.
 */
export const stripHtml = (html: string): string =>
  html
    .replace(/<br\s*\/?>/giu, "\n")
    // oxlint-disable-next-line sonarjs/slow-regex -- adapter strips known court HTML fragments before parsing text
    .replace(/<[^>]*>/gu, "")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#x([0-9a-f]+);/giu, (match, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return match;
      }
    })
    .replace(/&#(\d+);/gu, (match, dec: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10));
      } catch {
        return match;
      }
    })
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

/**
 * Parse Central-European date formats to ISO "YYYY-MM-DD".
 * Accepts "D. M. YYYY" (CZ) and "DD.MM.YYYY" (SK).
 */
export const parseCeDate = (dateStr: string): string | undefined => {
  const m = CE_DATE_PATTERN.exec(dateStr.trim());
  if (!m?.[1] || !m[2] || !m[3]) {
    return undefined;
  }
  const day = m[1].padStart(2, "0");
  const month = m[2].padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
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
