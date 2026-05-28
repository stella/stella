import { TaggedError } from "better-result";

/** DeepL rejected the API key (HTTP 401/403). */
export class DeepLAuthError extends TaggedError("DeepLAuthError")<{
  message: string;
  cause?: unknown;
}>() {}

/** DeepL character quota exhausted (HTTP 456). */
export class DeepLQuotaError extends TaggedError("DeepLQuotaError")<{
  message: string;
  cause?: unknown;
}>() {}

/** DeepL rate limit hit (HTTP 429). */
export class DeepLRateLimitError extends TaggedError("DeepLRateLimitError")<{
  message: string;
  cause?: unknown;
}>() {}

/** DeepL refused the document (unsupported format, too large, parse failure). */
export class DeepLDocumentError extends TaggedError("DeepLDocumentError")<{
  message: string;
  /** DeepL's `error_message` when the job ends in status="error". */
  detail?: string | undefined;
  cause?: unknown;
}>() {}

/** Catch-all for DeepL HTTP failures that don't map to the cases above. */
export class DeepLUpstreamError extends TaggedError("DeepLUpstreamError")<{
  message: string;
  httpStatus?: number | undefined;
  cause?: unknown;
}>() {}

/** Polling exceeded the wall-clock budget before DeepL finished. */
export class DeepLTimeoutError extends TaggedError("DeepLTimeoutError")<{
  message: string;
  documentId: string;
  elapsedMs: number;
}>() {}

export type DeepLError =
  | DeepLAuthError
  | DeepLQuotaError
  | DeepLRateLimitError
  | DeepLDocumentError
  | DeepLUpstreamError
  | DeepLTimeoutError;
