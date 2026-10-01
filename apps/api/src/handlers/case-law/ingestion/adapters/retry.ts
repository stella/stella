// parser-output-unchanged: fetch-stage observation preserves publisher response and error identity.
/**
 * The only way a case-law adapter reaches its publisher.
 *
 * {@link fetchPublisher} is one gated request; {@link fetchWithRetry} adds
 * exponential backoff with jitter over it. Both reserve the publisher's slot
 * first, so an adapter cannot spend a request the budget in
 * `publisher-policy.ts` never saw, and neither can forget to.
 */

import { panic } from "better-result";

import { fetchWithTimeout, type FetchWithTimeoutInit } from "@stll/fetch";
import type { DocumentFetchStage } from "@stll/legal-atlas/document-fetch-diagnostics";

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import {
  reservePublisherSlot,
  reservePublisherGateSlot,
  type PublisherGateId,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { observePublisherDocumentFetch } from "@/api/lib/legal-search/document-stage-observation";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { logger } from "@/api/lib/observability/logger";

import { INGESTION_USER_AGENT, isTimeoutError } from "./utils";

export type PublisherFetchInit = FetchWithTimeoutInit & {
  /** Whose publisher budget this request spends. */
  adapterKey: AdapterKey;
  fetchStage: DocumentFetchStage;
  /** A supplementary publisher, distinct from the decision listing's host. */
  publisherGate?: PublisherGateId | undefined;
  expectedContentType?: "pdf" | undefined;
};

/**
 * One request to a case-law publisher, behind that publisher's gate.
 *
 * The slot is reserved before the request, not after it: a reservation that
 * followed the call would pace the loop while letting the burst through.
 */
export const fetchPublisher = async (
  url: string | URL,
  {
    adapterKey,
    publisherGate,
    fetchStage,
    expectedContentType,
    ...init
  }: PublisherFetchInit,
): Promise<Response> => {
  if (publisherGate === undefined) {
    await reservePublisherSlot(adapterKey, init.signal);
  } else {
    await reservePublisherGateSlot(publisherGate, init.signal);
  }
  const request = async () =>
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- the publisher fetch boundary: the lint rule checks each target where fetchPublisher or fetchWithRetry is called
    await fetchWithTimeout(url, init);
  if (fetchStage === "listing") {
    return await request();
  }
  return await observePublisherDocumentFetch({
    source: adapterKey,
    fetch: request,
    expectedContentType,
  });
};

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
  /**
   * Whose publisher budget every attempt spends. Required: the gate is
   * reserved per attempt, and an attempt that named no publisher would be a
   * request the budget never saw.
   */
  adapterKey: AdapterKey;
  fetchStage: DocumentFetchStage;
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
};

/**
 * Whether a response status warrants a retry.
 *
 * A 5xx is the publisher failing to answer; a 429 is the publisher answering
 * that the budget is spent. Retrying the refusal spends the budget the halt
 * protects, so it is returned to the caller after exactly one request.
 */
const isRetryableStatus = (status: number): boolean => status >= 500;

/**
 * Fetch with exponential backoff retry.
 *
 * Retries on:
 * - Timeout errors (AbortSignal.timeout)
 * - HTTP 5xx (server errors)
 *
 * Does NOT retry on:
 * - Parent signal abort (cycle/page timeout)
 * - HTTP 4xx, the publisher's rate-limit refusal included (rule 19a)
 * - Network errors (DNS, connection refused)
 *
 * Returns the response even for retryable statuses after
 * exhausting retries, so the caller can decide what to do
 * (skip page, treat as miss, etc.).
 *
 * `init` takes Bun's fetch options too, for a publisher that answers only one
 * HTTP version.
 */
export const fetchWithRetry = async (
  url: string,
  init: BunFetchRequestInit | undefined,
  opts: FetchWithRetryOptions,
): Promise<Response> => {
  const {
    maxRetries = 2,
    timeoutMs = ADAPTER_TIMEOUT.REQUEST,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    signal,
    adapterKey,
    fetchStage,
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
      const response = await fetchPublisher(url, {
        ...init,
        adapterKey,
        fetchStage,
        headers,
        timeoutMs,
        signal,
      });

      if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
        return response;
      }

      // Retryable status: back off and retry
      const delay = backoffMs(attempt, baseDelayMs, maxDelayMs);
      logger.warn("case_law.ingestion.fetch_retry", {
        adapterKey,
        url,
        httpStatus: response.status,
        attempt: attempt + 1,
        maxRetries,
        delayMs: Math.round(delay),
      });
      await Bun.sleep(delay);
    } catch (error) {
      // Parent signal aborted: propagate immediately
      if (signal?.aborted) {
        throw error;
      }

      // Per-request timeout: retry with backoff
      if (isTimeoutError(error) && attempt < maxRetries) {
        const delay = backoffMs(attempt, baseDelayMs, maxDelayMs);
        logger.warn("case_law.ingestion.fetch_timeout_retry", {
          adapterKey,
          url,
          attempt: attempt + 1,
          maxRetries,
          delayMs: Math.round(delay),
        });
        await Bun.sleep(delay);
        continue;
      }

      throw error;
    }
  }

  // Unreachable: the loop always returns or throws
  return panic("fetchWithRetry: unreachable");
};
