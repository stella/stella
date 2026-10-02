// parser-output-unchanged: refusal stops are opt-in; existing response and retry semantics are unchanged.
/**
 * The only way a case-law adapter reaches its publisher.
 *
 * {@link fetchPublisher} gates each request and accepts an opt-in publisher
 * backoff policy; {@link fetchWithRetry} retains the legacy retry policy.
 * Both reserve the publisher's slot
 * first, so an adapter cannot spend a request the budget in
 * `publisher-policy.ts` never saw, and neither can forget to.
 */

import { Result, panic } from "better-result";

import { fetchWithTimeout, type FetchWithTimeoutInit } from "@stll/fetch";
import { Temporal } from "@stll/time";

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import {
  ADAPTER_PUBLISHER_GATES,
  deferPublisherGate,
  reservePublisherSlot,
  reservePublisherGateSlot,
  type PublisherGateId,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { INGESTION_STOP_KIND } from "@/api/lib/legal-search/ingestion-stop-kind";
import { logger } from "@/api/lib/observability/logger";

import { abortableSleep } from "./publisher-request-gate";
import { INGESTION_USER_AGENT, isTimeoutError } from "./utils";

export type PublisherFetchInit = FetchWithTimeoutInit & {
  /** Whose publisher budget this request spends. */
  adapterKey: AdapterKey;
  /** A supplementary publisher, distinct from the decision listing's host. */
  publisherGate?: PublisherGateId | undefined;
  retryPolicy?: "publisher-backoff";
  /** Existing workflows receive refusals; session adapters can stop explicitly. */
  refusalMode?: "return-response" | "stop-refusal" | undefined;
  /** Publisher-defined redirect target; use manual redirects to inspect it. */
  isRateLimitRedirect?: (response: Response) => boolean;
};

/**
 * A case-law publisher request, with optional retries behind the shared gate.
 *
 * The slot is reserved before the request, not after it: a reservation that
 * followed the call would pace the loop while letting the burst through.
 */
export const fetchPublisher = async (
  url: string | URL,
  { retryPolicy, ...init }: PublisherFetchInit,
): Promise<Response> => {
  if (retryPolicy === "publisher-backoff") {
    return await retryPublisherRequest(url, init);
  }
  const response = await fetchPublisherRequest(url, init);
  if (
    init.refusalMode === "stop-refusal" &&
    (response.status === 401 ||
      response.status === 403 ||
      response.status === 429)
  ) {
    const retryAfter = response.headers.get("Retry-After");
    await response.body?.cancel();
    throw new AdapterFetchError({
      message: `Publisher request refused: ${response.status}`,
      adapterKey: init.adapterKey,
      cursor: null,
      httpStatus: response.status,
      ...(retryAfter === null ? {} : { retryAfter }),
    });
  }
  return response;
};

const fetchPublisherRequest = async (
  url: string | URL,
  init: PublisherFetchInit,
): Promise<Response> => {
  const {
    adapterKey,
    publisherGate,
    refusalMode: _refusalMode,
    isRateLimitRedirect: _isRateLimitRedirect,
    ...requestInit
  } = init;
  if (publisherGate === undefined) {
    await reservePublisherSlot(adapterKey, requestInit.signal);
  } else {
    await reservePublisherGateSlot(publisherGate, requestInit.signal);
  }
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- the publisher fetch boundary: the lint rule checks each target where fetchPublisher or fetchWithRetry is called
  return await fetchWithTimeout(url, requestInit);
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
  refusalMode?: "return-response" | "stop-refusal" | undefined;
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
 * protects, so the caller receives the refusal after exactly one request.
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
 * Returns HTTP refusals by default. Session workflows may opt into a typed
 * stop on 401/403/429; that choice does not affect existing adapters.
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
    refusalMode,
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
        refusalMode,
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

type PublisherRateLimitRefusalErrorOptions = {
  cursor: string | null;
  publisherKey: PublisherGateId;
  status: number;
  cooldownUntilEpochMs: number;
  adapterKey: AdapterKey;
};

/** A terminal refusal for this cycle; its shared cooldown uses the Redis TIME clock. */
export class PublisherRateLimitRefusalError extends AdapterFetchError {
  readonly publisherKey: PublisherGateId;
  readonly status: number;
  readonly cooldownUntilEpochMs: number;

  constructor({
    publisherKey,
    status,
    cooldownUntilEpochMs,
    adapterKey,
    cursor,
  }: PublisherRateLimitRefusalErrorOptions) {
    super({
      message: `Publisher rate limit refused: ${status}`,
      adapterKey,
      cursor,
      httpStatus: status,
      stopKind: INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
    });
    this.name = "PublisherRateLimitRefusalError";
    this.publisherKey = publisherKey;
    this.status = status;
    this.cooldownUntilEpochMs = cooldownUntilEpochMs;
  }
}

const PUBLISHER_MAX_ATTEMPTS = 6;
const PUBLISHER_BASE_DELAY_MS = 2000;
const PUBLISHER_MAX_DELAY_MS = 300_000;
const RETRY_AFTER_MAX_MS = 900_000;
const PUBLISHER_RETRY_STATUSES = new Set([408, 502, 503, 504]);

type PublisherRetryDelayOptions = {
  attempt: number;
  retryAfter: string | null;
  now: number;
  random: number;
};

/** Parse the protocol value before a publisher policy applies its own bounds. */
export const parsePublisherRetryAfter = (
  retryAfter: string | null,
  now: number,
): number | null => {
  if (retryAfter === null) {
    return null;
  }
  const value = retryAfter.trim();
  // The platform date parser accepts bare numbers and non-HTTP dates; reject those rather
  // than interpreting malformed delta-seconds as a calendar date.
  let parsed = Number.NaN;
  if (/^\d+$/u.test(value)) {
    parsed = Number(value) * 1000;
  } else if (
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/u.test(
      value,
    )
  ) {
    // HTTP-date is a legacy protocol grammar rather than Temporal's ISO grammar.
    parsed = new Date(value).getTime() - now;
  }
  return Number.isNaN(parsed) ? null : parsed;
};

/** Full jitter, with the publisher's bounded Retry-After as a minimum. */
export const publisherRetryDelay = ({
  attempt,
  retryAfter,
  now,
  random,
}: PublisherRetryDelayOptions): number => {
  const jitter =
    random *
    Math.min(PUBLISHER_BASE_DELAY_MS * 2 ** attempt, PUBLISHER_MAX_DELAY_MS);
  const parsed = parsePublisherRetryAfter(retryAfter, now);
  if (parsed === null) {
    return jitter;
  }
  return Math.max(jitter, Math.min(Math.max(0, parsed), RETRY_AFTER_MAX_MS));
};

const isPublisherTimeout = (cause: unknown): boolean =>
  isTimeoutError(cause) ||
  (cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ETIMEDOUT" || cause.code === "ESOCKETTIMEDOUT"));

type PublisherRetryDependencies = {
  request: (url: string | URL, init: PublisherFetchInit) => Promise<Response>;
  defer: (durationMs: number, signal?: AbortSignal) => Promise<number>;
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
};

/** Opt-in retry policy; existing publishers retain their request semantics. */
export const retryPublisherRequest = async (
  url: string | URL,
  init: PublisherFetchInit,
  dependencies?: PublisherRetryDependencies,
): Promise<Response> => {
  const runtime = dependencies ?? {
    request: fetchPublisherRequest,
    defer: async (durationMs: number, signal?: AbortSignal) =>
      await deferPublisherGate(
        init.publisherGate ?? ADAPTER_PUBLISHER_GATES[init.adapterKey],
        durationMs,
        signal,
      ),
    sleep: abortableSleep,
    now: () => Temporal.Now.instant().epochMilliseconds,
    random: Math.random,
  };
  const {
    retryPolicy: _retryPolicy,
    isRateLimitRedirect,
    ...requestInit
  } = init;
  for (let attempt = 0; attempt < PUBLISHER_MAX_ATTEMPTS; attempt++) {
    init.signal?.throwIfAborted();
    const fetched = await Result.tryPromise({
      try: async () => await runtime.request(url, requestInit),
      catch: (cause) =>
        new AdapterFetchError({
          message: "Publisher request failed",
          adapterKey: init.adapterKey,
          cursor: null,
          cause,
        }),
    });
    init.signal?.throwIfAborted();
    if (
      Result.isOk(fetched) &&
      init.refusalMode === "stop-refusal" &&
      (fetched.value.status === 401 || fetched.value.status === 403)
    ) {
      const retryAfter = fetched.value.headers.get("Retry-After");
      await fetched.value.body?.cancel();
      throw new AdapterFetchError({
        message: `Publisher request refused: ${fetched.value.status}`,
        adapterKey: init.adapterKey,
        cursor: null,
        httpStatus: fetched.value.status,
        ...(retryAfter === null ? {} : { retryAfter }),
      });
    }
    if (Result.isError(fetched) && !isPublisherTimeout(fetched.error.cause)) {
      throw fetched.error;
    }
    if (
      Result.isOk(fetched) &&
      (fetched.value.status === 429 || isRateLimitRedirect?.(fetched.value))
    ) {
      const delay = Math.ceil(
        publisherRetryDelay({
          attempt,
          retryAfter: fetched.value.headers.get("Retry-After"),
          now: runtime.now(),
          random: runtime.random(),
        }),
      );
      const cooldownUntilEpochMs = await runtime.defer(delay, init.signal);
      await fetched.value.body?.cancel();
      throw new PublisherRateLimitRefusalError({
        cursor: null,
        publisherKey:
          init.publisherGate ?? ADAPTER_PUBLISHER_GATES[init.adapterKey],
        status: fetched.value.status,
        cooldownUntilEpochMs,
        adapterKey: init.adapterKey,
      });
    }
    if (
      Result.isOk(fetched) &&
      !PUBLISHER_RETRY_STATUSES.has(fetched.value.status)
    ) {
      return fetched.value;
    }
    if (attempt === PUBLISHER_MAX_ATTEMPTS - 1) {
      if (Result.isError(fetched)) {
        throw fetched.error;
      }
      await fetched.value.body?.cancel();
      throw new AdapterFetchError({
        message: `Publisher retry budget exhausted: ${fetched.value.status}`,
        adapterKey: init.adapterKey,
        cursor: null,
        httpStatus: fetched.value.status,
      });
    }
    const delay = Math.ceil(
      publisherRetryDelay({
        attempt,
        retryAfter: Result.isOk(fetched)
          ? fetched.value.headers.get("Retry-After")
          : null,
        now: runtime.now(),
        random: runtime.random(),
      }),
    );
    // Publish the cooldown before sleeping. The Redis gate checks it before
    // every ECJ request, including slots reserved before this backoff began.
    await runtime.defer(delay, init.signal);
    if (Result.isOk(fetched)) {
      await fetched.value.body?.cancel();
    }
    await runtime.sleep(delay, init.signal);
  }
  return panic("retryPublisherRequest: unreachable");
};
