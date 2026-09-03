import { TaggedError } from "better-result";

/**
 * Why a provider cursor cannot be continued. Named rather than flagged,
 * because every answer requires a fresh first page and only the reason tells
 * an operator whether decoding or a corpus-version change invalidated it.
 */
export type InvalidLegalSearchCursorReason =
  | "dictionary_mismatch"
  | "undecodable";

/**
 * A continuation page cannot be served for the cursor it was asked with.
 * Providers return this rather than silently restarting at page one, which a
 * client that appends pages reads as duplicate results.
 */
export class InvalidLegalSearchCursorError extends TaggedError(
  "InvalidLegalSearchCursorError",
)<{
  message: string;
  reason: InvalidLegalSearchCursorReason;
}> {}

/**
 * A legal-search provider could not complete an otherwise valid query.
 * Keep the cause for structured telemetry, but do not copy query text into
 * the error: search terms may contain sensitive legal or personal data.
 */
export class LegalSearchUnavailableError extends TaggedError(
  "LegalSearchUnavailableError",
)<{
  message: string;
  cause?: unknown;
}> {}

export type LegalSearchError =
  | InvalidLegalSearchCursorError
  | LegalSearchUnavailableError;
