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

const CE_DATE_PATTERN =
  /^(?<day>\d{1,2})\.\s*(?<month>\d{1,2})\.\s*(?<year>\d{4})$/;

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
 * Remove every `<`…`>` span, taking each `<` to the next `>` exactly as
 * `/<[^>]*>/g` does, and leaving a trailing unterminated `<` in place.
 *
 * Written as a scan rather than a pattern because both regex spellings
 * are wrong in their own way on the multi-megabyte pages this runs over.
 * `[^>]*` re-walks the remainder of the input from every `<` when no `>`
 * follows, which is quadratic; narrowing it to `[^<>]*` is linear but
 * silently weakens the strip, leaving `<script` behind on input like
 * `<script <x>`. Indexed scanning is linear and keeps the original
 * meaning.
 */
const stripTags = (html: string): string => {
  let out = "";
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      return out + html.slice(cursor);
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      // No closing bracket: `/<[^>]*>/` would not match here either.
      return out + html.slice(cursor);
    }
    out += html.slice(cursor, open);
    cursor = close + 1;
  }

  return out;
};

/**
 * Strip HTML tags, decode common entities (including numeric
 * &#xNN; and &#NNNN; forms), and collapse excessive newlines.
 */
export const stripHtml = (html: string): string =>
  stripTags(html.replace(/<br\s*\/?>/gi, "\n"))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x(?<hex>[0-9a-f]+);/gi, (match, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return match;
      }
    })
    .replace(/&#(?<dec>\d+);/g, (match, dec: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10));
      } catch {
        return match;
      }
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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
