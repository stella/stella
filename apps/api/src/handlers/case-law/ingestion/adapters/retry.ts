// parser-output-unchanged: completion failures return Results to the job boundary; adapter parsing and ordinary request semantics are unchanged.
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
  reservePublisherGateSlot,
  type PublisherGateId,
  publisherRunControls,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { logger } from "@/api/lib/observability/logger";

import { abortableSleep } from "./publisher-request-gate";
import { publisherTarget } from "./publisher-target";
import { INGESTION_USER_AGENT, isTimeoutError } from "./utils";

const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export type PublisherFetchInit = FetchWithTimeoutInit & {
  /** Whose publisher budget this request spends. */
  adapterKey: AdapterKey;
  /** A supplementary publisher, distinct from the decision listing's host. */
  publisherGate?: PublisherGateId | undefined;
  retryPolicy?: "publisher-backoff";
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
  const {
    adapterKey,
    publisherGate,
    isRateLimitRedirect: _isRateLimitRedirect,
    ...requestInit
  } = init;
  const gateId = publisherGate ?? ADAPTER_PUBLISHER_GATES[adapterKey];
  const controls = publisherRunControls(gateId);
  const request = async (
    target: string | URL,
    requestOptions: FetchWithTimeoutInit,
  ) =>
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- canonical publisher boundary; callers validate the target
    await fetchWithTimeout(target, requestOptions);
  if (controls === undefined) {
    await reservePublisherGateSlot(gateId, requestInit.signal);
    return await request(url, requestInit);
  }
  const fetchTarget = async (
    requestedTarget: string,
    redirects: number,
  ): Promise<Result<Response, unknown>> =>
    await Result.gen(async function* () {
      yield* Result.await(controls.check());
      const target = yield* publisherTarget(adapterKey, requestedTarget);
      yield* Result.await(controls.chargeRequest());
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await reservePublisherGateSlot(gateId, requestInit.signal),
          catch: (error) => error,
        }),
      );
      yield* controls.checkBeforeSend();
      const fetched = await Result.tryPromise({
        try: async () =>
          await request(target, { ...requestInit, redirect: "manual" }),
        catch: (error) => error,
      });
      if (fetched.isErr()) {
        controls.onFailure?.(fetched.error);
        return fetched;
      }
      const response = fetched.value;
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 429 ||
        _isRateLimitRedirect?.(response)
      ) {
        const refusalNow = Temporal.Now.instant().epochMilliseconds;
        const delay = Math.ceil(
          publisherRetryDelay({
            attempt: 0,
            retryAfter: response.headers.get("Retry-After"),
            now: refusalNow,
            random: Math.random(),
            retryAfterMaxMs: MAX_DATE_EPOCH_MS - refusalNow,
          }),
        );
        controls.onRefusal?.(refusalNow + delay);
        const cooldownUntilEpochMs = yield* Result.await(
          Result.tryPromise({
            try: async () =>
              await deferPublisherGate(
                gateId,
                Math.min(delay, RETRY_AFTER_MAX_MS),
                requestInit.signal,
              ),
            catch: (error) => error,
          }),
        );
        yield* Result.await(
          Result.tryPromise({
            try: async () => await response.body?.cancel(),
            catch: (error) => error,
          }),
        );
        return Result.err(
          new PublisherRateLimitRefusalError({
            publisherKey: gateId,
            status: response.status,
            cooldownUntilEpochMs,
            adapterKey,
            cursor: null,
          }),
        );
      }
      if (response.status >= 500 || response.status === 408) {
        controls.onFailure?.(
          new AdapterFetchError({
            message: "Publisher completion request failed",
            adapterKey,
            cursor: null,
            httpStatus: response.status,
          }),
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return Result.ok(controls.limitResponse?.(response) ?? response);
      }
      const location = response.headers.get("location");
      yield* Result.await(
        Result.tryPromise({
          try: async () => await response.body?.cancel(),
          catch: (error) => error,
        }),
      );
      if (location === null || redirects === 5) {
        return Result.err(
          new AdapterFetchError({
            message:
              "Publisher redirect cannot be followed within the request budget",
            adapterKey,
            cursor: null,
          }),
        );
      }
      if (requestInit.method !== undefined && requestInit.method !== "GET") {
        return Result.err(
          new AdapterFetchError({
            message: "Publisher redirected a non-GET completion request",
            adapterKey,
            cursor: null,
          }),
        );
      }
      const redirected = yield* Result.try({
        try: () => new URL(location, target).href,
        catch: (error) => error,
      });
      return Result.ok(
        yield* Result.await(fetchTarget(redirected, redirects + 1)),
      );
    });
  const result = await fetchTarget(String(url), 0);
  return result.isOk() ? result.value : controls.raiseFailure(result.error);
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
        headers,
        timeoutMs,
        signal,
      });

      if (
        publisherRunControls(ADAPTER_PUBLISHER_GATES[adapterKey])?.retry ===
          "durable" ||
        !isRetryableStatus(response.status) ||
        attempt >= maxRetries
      ) {
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
      if (
        publisherRunControls(ADAPTER_PUBLISHER_GATES[adapterKey]) ===
          undefined &&
        isTimeoutError(error) &&
        attempt < maxRetries
      ) {
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
  retryAfterMaxMs?: number;
};

/** Full jitter, with the publisher's bounded Retry-After as a minimum. */
export const publisherRetryDelay = ({
  attempt,
  retryAfter,
  now,
  random,
  retryAfterMaxMs = RETRY_AFTER_MAX_MS,
}: PublisherRetryDelayOptions): number => {
  const jitter =
    random *
    Math.min(PUBLISHER_BASE_DELAY_MS * 2 ** attempt, PUBLISHER_MAX_DELAY_MS);
  if (retryAfter === null) {
    return jitter;
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
  if (Number.isNaN(parsed)) {
    return jitter;
  }
  return Math.max(jitter, Math.min(Math.max(0, parsed), retryAfterMaxMs));
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
  const gateId = init.publisherGate ?? ADAPTER_PUBLISHER_GATES[init.adapterKey];
  const controls = publisherRunControls(gateId);
  const runtime = dependencies ?? {
    request: fetchPublisher,
    defer: async (durationMs: number, signal?: AbortSignal) =>
      await deferPublisherGate(gateId, durationMs, signal),
    sleep: abortableSleep,
    now: () => Temporal.Now.instant().epochMilliseconds,
    random: Math.random,
  };
  const { retryPolicy: _retryPolicy, ...requestInit } = init;
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
    if (Result.isError(fetched) && !isPublisherTimeout(fetched.error.cause)) {
      throw fetched.error;
    }
    if (
      Result.isOk(fetched) &&
      (fetched.value.status === 429 ||
        (controls !== undefined &&
          (fetched.value.status === 401 || fetched.value.status === 403)) ||
        init.isRateLimitRedirect?.(fetched.value))
    ) {
      const delay = Math.ceil(
        publisherRetryDelay({
          attempt,
          retryAfter: fetched.value.headers.get("Retry-After"),
          now: runtime.now(),
          random: runtime.random(),
          ...(controls === undefined
            ? {}
            : { retryAfterMaxMs: MAX_DATE_EPOCH_MS - runtime.now() }),
        }),
      );
      controls?.onRefusal?.(runtime.now() + delay);
      const cooldownUntilEpochMs = await runtime.defer(
        Math.min(delay, RETRY_AFTER_MAX_MS),
        init.signal,
      );
      await fetched.value.body?.cancel();
      throw new PublisherRateLimitRefusalError({
        cursor: null,
        publisherKey: gateId,
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
    if (
      publisherRunControls(gateId)?.retry === "durable" ||
      attempt === PUBLISHER_MAX_ATTEMPTS - 1
    ) {
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
