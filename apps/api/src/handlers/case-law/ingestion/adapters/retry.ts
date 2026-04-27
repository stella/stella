/**
 * Shared retry and backoff utilities for case-law adapters.
 *
 * Provides consistent exponential backoff with jitter across
 * all adapters, replacing ad-hoc linear/fixed delays.
 */

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import { logger } from "@/api/lib/observability/logger";

import { INGESTION_USER_AGENT, isTimeoutError } from "./utils";

/**
 * Compute exponential backoff delay with jitter.
 *
 *   delay = min(baseMs × 2^attempt + random(0, baseMs), maxMs)
 *
 * Jitter prevents thundering-herd when multiple adapters
 * retry simultaneously against the same court server.
 */
export const backoffMs = (
  attempt: number,
  baseMs = 1000,
  maxMs = 30_000,
): number => Math.min(baseMs * 2 ** attempt + Math.random() * baseMs, maxMs);

type FetchWithRetryOptions = {
  /** Maximum retry attempts (default: 2). */
  maxRetries?: number;
  /** Per-request timeout in ms (default: ADAPTER_TIMEOUT.REQUEST). */
  timeoutMs?: number;
  /** Base delay for exponential backoff in ms (default: 1000). */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 30000). */
  maxDelayMs?: number;
  /**
   * Parent signal (cycle/page abort). When this fires, retries
   * stop immediately and the abort error propagates.
   */
  signal?: AbortSignal | undefined;
  /** Adapter key for structured log context. */
  adapterKey?: string;
};

/**
 * Whether a response status warrants a retry.
 * 429 (rate limit) and 5xx (server error) are retryable.
 */
const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

/**
 * Fetch with exponential backoff retry.
 *
 * Retries on:
 * - Timeout errors (AbortSignal.timeout)
 * - HTTP 429 (rate limited)
 * - HTTP 5xx (server errors)
 *
 * Does NOT retry on:
 * - Parent signal abort (cycle/page timeout)
 * - HTTP 4xx (client errors, except 429)
 * - Network errors (DNS, connection refused)
 *
 * Returns the response even for retryable statuses after
 * exhausting retries, so the caller can decide what to do
 * (skip page, treat as miss, etc.).
 */
export const fetchWithRetry = async (
  url: string,
  init: RequestInit | undefined,
  opts: FetchWithRetryOptions = {},
): Promise<Response> => {
  const {
    maxRetries = 2,
    timeoutMs = ADAPTER_TIMEOUT.REQUEST,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    signal,
    adapterKey,
  } = opts;

  const headers = new Headers(init?.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", INGESTION_USER_AGENT);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });

      if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
        return response;
      }

      // Retryable status: back off and retry
      const delay = backoffMs(
        attempt,
        response.status === 429 ? baseDelayMs * 2 : baseDelayMs,
        maxDelayMs,
      );
      if (adapterKey) {
        logger.warn("case_law.ingestion.fetch_retry", {
          adapterKey,
          url,
          httpStatus: response.status,
          attempt: attempt + 1,
          maxRetries,
          delayMs: Math.round(delay),
        });
      }
      await Bun.sleep(delay);
    } catch (error) {
      // Parent signal aborted: propagate immediately
      if (signal?.aborted) {
        throw error;
      }

      // Per-request timeout: retry with backoff
      if (isTimeoutError(error) && attempt < maxRetries) {
        const delay = backoffMs(attempt, baseDelayMs, maxDelayMs);
        if (adapterKey) {
          logger.warn("case_law.ingestion.fetch_timeout_retry", {
            adapterKey,
            url,
            attempt: attempt + 1,
            maxRetries,
            delayMs: Math.round(delay),
          });
        }
        await Bun.sleep(delay);
        continue;
      }

      throw error;
    }
  }

  // Unreachable: the loop always returns or throws
  throw new Error("fetchWithRetry: unreachable");
};
