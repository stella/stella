// Shared HTTP scaffold for registry adapters.
//
// Every adapter's client hand-rolled the same three mechanical steps:
//   1. fetch with a timeout AbortSignal, wrapping any transport failure
//      in the adapter's RequestError;
//   2. branch on the response status, mapping non-OK responses to the
//      adapter's APIError (and, where relevant, not-found/auth cases);
//   3. read the JSON body and run a shape guard, mapping a non-JSON body
//      or a shape mismatch to a typed error.
//
// This module single-homes those steps. Per-adapter clients supply only
// the parts that genuinely differ: the typed error constructors, the
// not-found handling, and any auth/too-broad branches. Adapters that
// serve text or XML (GCIS, DENUE) reuse the request layer but decode the
// body themselves; adapters that pin a custom trust store (KRS) pass it
// through `init`.

import { RegistryRateLimitedError } from "./errors.js";

/** Default per-request timeout. Every adapter used 10s. */
export const DEFAULT_REGISTRY_TIMEOUT_MS = 10_000;

export type RegistryRequestOptions = {
  url: string;
  /**
   * Extra fetch options (method, body, headers, and Bun-only `tls`).
   * Spread after the timeout signal so a caller can override the signal
   * or add a custom trust store — KRS pins Certum CA certs this way.
   */
  init?: RequestInit;
  /** @default DEFAULT_REGISTRY_TIMEOUT_MS */
  timeoutMs?: number;
  /** Map a transport/timeout failure into the adapter's RequestError. */
  wrapRequestError: (cause: unknown) => Error;
};

/**
 * Perform a fetch with a timeout AbortSignal, wrapping any transport
 * failure via `wrapRequestError`. Returns the raw Response so callers
 * keep full control over status branching and body decoding (JSON,
 * text, XML). This is the one piece every adapter shares, including the
 * text/non-JSON ones.
 */
export const performRegistryRequest = async (
  options: RegistryRequestOptions,
): Promise<Response> => {
  try {
    return await fetch(options.url, {
      signal: AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS,
      ),
      ...options.init,
    });
  } catch (error) {
    throw options.wrapRequestError(error);
  }
};

export type ReadRegistryJsonOptions<T> = {
  response: Response;
  isExpectedShape: (value: unknown) => value is T;
  /** Thrown when the body is not valid JSON. */
  wrapParseError: (cause: unknown) => Error;
  /** Thrown when the parsed JSON fails `isExpectedShape`. */
  wrapShapeError: () => Error;
};

/**
 * Read and shape-guard a JSON response body. Adapters that serve text or
 * XML decode the body themselves and skip this helper.
 */
export const readRegistryJson = async <T>(
  options: ReadRegistryJsonOptions<T>,
): Promise<T> => {
  let body: unknown;
  try {
    body = await options.response.json();
  } catch (error) {
    throw options.wrapParseError(error);
  }
  if (!options.isExpectedShape(body)) {
    throw options.wrapShapeError();
  }
  return body;
};

export type RegistryFetchOptions<T> = RegistryRequestOptions & {
  isExpectedShape: (value: unknown) => value is T;
  /**
   * Thrown when a 2xx body is not valid JSON. Receives the (OK)
   * response so the error can carry its status.
   */
  wrapParseError: (response: Response, cause: unknown) => Error;
  /** Thrown when a 2xx body fails `isExpectedShape`. */
  wrapShapeError: (response: Response) => Error;
  /**
   * Handle any non-OK response. Return `null` to resolve the request to
   * "no result" (the not-found convention several adapters use), or
   * throw the adapter's APIError. Which status set means not-found, and
   * whether the error body is inspected, is adapter-specific, so it
   * stays here rather than in the shared core.
   */
  onErrorResponse: (response: Response) => T | null | Promise<T | null>;
  /**
   * Optional 429 handler, invoked before `onErrorResponse`. When
   * omitted, a 429 flows through `onErrorResponse` like any other non-OK
   * status — today's behaviour for every adapter. This is the single
   * wiring point for a future retry layer; see {@link rateLimitedError}.
   */
  onRateLimited?: (response: Response) => T | null | Promise<T | null>;
};

/**
 * Compose {@link performRegistryRequest} and {@link readRegistryJson}
 * for the common JSON adapter shape: fetch, delegate non-OK responses to
 * `onErrorResponse` (with an optional rate-limit shortcut), otherwise
 * parse and guard the JSON body.
 */
export const registryFetch = async <T>(
  options: RegistryFetchOptions<T>,
): Promise<T | null> => {
  const response = await performRegistryRequest(options);
  if (!response.ok) {
    if (response.status === 429 && options.onRateLimited) {
      return options.onRateLimited(response);
    }
    return options.onErrorResponse(response);
  }
  return readRegistryJson({
    response,
    isExpectedShape: options.isExpectedShape,
    wrapParseError: (cause) => options.wrapParseError(response, cause),
    wrapShapeError: () => options.wrapShapeError(response),
  });
};

/**
 * Parse a `Retry-After` header into milliseconds. Supports both the
 * delta-seconds form (`Retry-After: 120`) and the HTTP-date form
 * (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). Returns `null` when
 * the header is absent or unparseable, and never returns a negative
 * value.
 *
 * Single-homed here so a future retry layer (see
 * `RegistryRateLimitedError.retryAfterMs`) has one place to read the
 * budget; no adapter retries today.
 */
export const parseRetryAfterMs = (response: Response): number | null => {
  const header = response.headers.get("retry-after");
  if (!header) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  return Math.max(dateMs - Date.now(), 0);
};

export type RateLimitedErrorOptions = {
  response: Response;
  message: string;
  cause?: unknown;
};

/**
 * Build a {@link RegistryRateLimitedError} from a 429 response, reading
 * the retry budget from the `Retry-After` header. Adapters do not wire
 * this in yet — that would change today's behaviour, where 429 maps to
 * the adapter's own APIError — but it lives here so rate-limit handling
 * has a single home when a retry layer is added.
 */
export const rateLimitedError = (
  options: RateLimitedErrorOptions,
): RegistryRateLimitedError =>
  new RegistryRateLimitedError({
    message: options.message,
    retryAfterMs: parseRetryAfterMs(options.response),
    cause: options.cause,
  });
