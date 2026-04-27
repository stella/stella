/**
 * Shared pagination helpers for case-law adapters.
 *
 * These reduce boilerplate in adapters that follow
 * common pagination patterns. Adapters with unique
 * pagination (CZ-constitutional enumeration, EU-ECJ
 * multi-language) should implement fetchPage directly.
 */

import { Result } from "better-result";

import { ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  isTimeoutError,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { captureError } from "@/api/lib/analytics";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

/**
 * Options for page-number pagination (1-indexed or
 * 0-indexed). Covers: SK, PL, AT, CZ-supreme-admin,
 * EE, HR, and similar adapters.
 */
type PagePaginationOptions<TResponse> = {
  /** Adapter key for error context. */
  adapterKey: string;
  /** Whether page numbers are 0-indexed (default: false = 1-indexed). */
  zeroIndexed?: boolean | undefined;
  /** Number of items per page (used to detect last page). */
  pageSize: number;
  /**
   * Build the fetch request for a given page number.
   * Return the URL and optional RequestInit overrides.
   */
  buildRequest: (page: number) => { url: string; init?: RequestInit };
  /**
   * Parse the raw response into a typed result.
   * Should throw on unexpected response shapes.
   */
  parseResponse: (response: Response) => Promise<TResponse>;
  /**
   * Extract items from the parsed response.
   * Return the items and optional total count.
   */
  extractItems: (data: TResponse) => {
    items: unknown[];
    total?: number | undefined;
  };
  /**
   * Per-request timeout for the list/page fetch (ms).
   * Defaults to ADAPTER_TIMEOUT.LIST (15s).
   */
  listTimeoutMs?: number | undefined;
  /**
   * Transform a single raw item into an IngestionResult.
   * May perform secondary fetches (detail pages, fulltext).
   * Return null to skip the item.
   */
  parseItem: (
    item: unknown,
    signal?: AbortSignal,
  ) => Promise<IngestionResult | null>;
};

/**
 * Create a fetchPage function for page-number based
 * adapters. Handles cursor parsing, request building,
 * pagination logic, and error wrapping.
 *
 * @example
 * ```ts
 * export const myAdapter: SourceAdapter = {
 *   key: ADAPTER_KEYS.MY_ADAPTER,
 *   // ...
 *   fetchPage: createPagePaginatedFetch({
 *     adapterKey: ADAPTER_KEYS.MY_ADAPTER,
 *     pageSize: 20,
 *     buildRequest: (page) => ({
 *       url: `https://api.example.com/search?page=${page}`,
 *     }),
 *     parseResponse: async (resp) => resp.json(),
 *     extractItems: (data) => ({
 *       items: data.results,
 *       total: data.totalCount,
 *     }),
 *     parseItem: async (raw) => transformToResult(raw),
 *   }),
 * };
 * ```
 */
/** Max retries for transient 5xx / timeout errors before skipping. */
const SERVER_ERROR_RETRIES = 2;
const SERVER_ERROR_RETRY_DELAY_MS = 5000;

export const createPagePaginatedFetch = <TResponse>(
  opts: PagePaginationOptions<TResponse>,
) => {
  const firstPage = opts.zeroIndexed ? 0 : 1;

  return async (
    cursor: string | null,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result<SyncPage, AdapterFetchError>> =>
    await Result.tryPromise({
      try: async () => {
        const page = cursor ? Number.parseInt(cursor, 10) : firstPage;

        if (Number.isNaN(page) || page < firstPage) {
          throw new AdapterFetchError({
            message: `${opts.adapterKey}: invalid cursor`,
            adapterKey: opts.adapterKey,
            cursor,
          });
        }

        const { url, init } = opts.buildRequest(page);
        const fetchT0 = performance.now();

        // Retry on 5xx / timeout up to SERVER_ERROR_RETRIES times.
        const listTimeout = opts.listTimeoutMs ?? ADAPTER_TIMEOUT.LIST;
        let response: Response | undefined;
        for (let attempt = 0; attempt <= SERVER_ERROR_RETRIES; attempt++) {
          // If the parent cycle signal is already aborted, don't
          // retry — the pipeline will handle the cancellation.
          if (signal?.aborted) {
            throw new DOMException("Cycle aborted", "AbortError");
          }

          const headers = new Headers(init?.headers);
          if (!headers.has("User-Agent")) {
            headers.set("User-Agent", INGESTION_USER_AGENT);
          }

          try {
            response = await fetch(url, {
              ...init,
              headers,
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(listTimeout)])
                : AbortSignal.timeout(listTimeout),
            });
          } catch (fetchError) {
            // Timeout: retry with backoff unless exhausted.
            // Abort from the parent cycle signal is not retried.
            if (isTimeoutError(fetchError) && !signal?.aborted) {
              if (attempt < SERVER_ERROR_RETRIES) {
                const delayMs = SERVER_ERROR_RETRY_DELAY_MS * (attempt + 1);
                logger.warn("case_law.ingestion.page_timeout_retry", {
                  adapterKey: opts.adapterKey,
                  page,
                  timeoutMs: listTimeout,
                  retry: attempt + 1,
                  maxRetries: SERVER_ERROR_RETRIES,
                  retryDelayMs: delayMs,
                });
                await Bun.sleep(delayMs);
                continue;
              }
              // Exhausted retries: skip this page and advance
              // so the adapter doesn't stall on a single slow page.
              logger.warn("case_law.ingestion.page_timeout_exhausted", {
                adapterKey: opts.adapterKey,
                page,
                timeoutMs: listTimeout,
                retries: SERVER_ERROR_RETRIES,
              });
              captureError(
                new AdapterFetchError({
                  message:
                    `${opts.adapterKey}: page ${page} timed out after ` +
                    `${SERVER_ERROR_RETRIES} retries, skipping`,
                  adapterKey: opts.adapterKey,
                  cursor,
                }),
              );
              return {
                decisions: [],
                nextCursor: String(page + 1),
              };
            }
            throw fetchError;
          }

          if (response.ok || response.status < 500) {
            break;
          }

          if (attempt < SERVER_ERROR_RETRIES) {
            logger.warn("case_law.ingestion.page_server_error_retry", {
              adapterKey: opts.adapterKey,
              page,
              httpStatus: response.status,
              retry: attempt + 1,
              maxRetries: SERVER_ERROR_RETRIES,
            });
            await Bun.sleep(SERVER_ERROR_RETRY_DELAY_MS);
          }
        }

        if (!response) {
          throw new AdapterFetchError({
            message: `${opts.adapterKey}: no response after ${SERVER_ERROR_RETRIES} retries`,
            adapterKey: opts.adapterKey,
            cursor,
          });
        }

        if (!response.ok) {
          // 5xx after all retries: skip this page and advance
          if (response.status >= 500) {
            captureError(
              new AdapterFetchError({
                message:
                  `${opts.adapterKey}: page ${page} returned ` +
                  `${response.status} after ${SERVER_ERROR_RETRIES} ` +
                  "retries, skipping",
                adapterKey: opts.adapterKey,
                cursor,
                httpStatus: response.status,
              }),
            );
            return {
              decisions: [],
              nextCursor: String(page + 1),
            };
          }

          throw new AdapterFetchError({
            message: `${opts.adapterKey}: HTTP ${response.status}`,
            adapterKey: opts.adapterKey,
            cursor,
            httpStatus: response.status,
          });
        }

        let data: TResponse;
        try {
          data = await opts.parseResponse(response);
        } catch (parseError) {
          // Some court APIs return HTML error pages with 200 status
          // (rate limits, maintenance). Retry once after a delay.
          if (parseError instanceof SyntaxError) {
            const contentType =
              response.headers.get("content-type") ?? "unknown";
            logger.warn("case_law.ingestion.page_unparseable_retry", {
              adapterKey: opts.adapterKey,
              page,
              contentType,
              retryDelayMs: SERVER_ERROR_RETRY_DELAY_MS,
            });
            await Bun.sleep(SERVER_ERROR_RETRY_DELAY_MS);
            const retryHeaders = new Headers(init?.headers);
            if (!retryHeaders.has("User-Agent")) {
              retryHeaders.set("User-Agent", INGESTION_USER_AGENT);
            }
            const retryResponse = await fetch(url, {
              ...init,
              headers: retryHeaders,
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(listTimeout)])
                : AbortSignal.timeout(listTimeout),
            });
            if (!retryResponse.ok) {
              throw new AdapterFetchError({
                message: `${opts.adapterKey}: retry HTTP ${retryResponse.status}`,
                adapterKey: opts.adapterKey,
                cursor,
                httpStatus: retryResponse.status,
              });
            }
            try {
              data = await opts.parseResponse(retryResponse);
            } catch (retryParseError) {
              const retryContentType =
                retryResponse.headers.get("content-type") ?? "unknown";
              const detail =
                retryParseError instanceof SyntaxError
                  ? `unparseable (content-type: ${retryContentType})`
                  : `validation failed: ${retryParseError instanceof Error ? retryParseError.message : String(retryParseError)}`;
              throw new AdapterFetchError({
                message: `${opts.adapterKey}: page ${page} retry ${detail}`,
                adapterKey: opts.adapterKey,
                cursor,
              });
            }
          } else {
            throw parseError;
          }
        }
        const fetchMs = Math.round(performance.now() - fetchT0);
        const { items, total } = opts.extractItems(data);
        const decisions: IngestionResult[] = [];

        let itemsSkipped = 0;
        for (const item of items) {
          // Stop processing if the page/cycle signal fired
          // during a previous item's detail fetch. Return
          // partial results so the cursor still advances.
          if (signal?.aborted) {
            break;
          }
          try {
            const parsed = await opts.parseItem(item, signal);
            if (parsed) {
              decisions.push(parsed);
            }
          } catch {
            // Page/cycle timeout fired during this item's
            // processing. Stop and return partial results
            // instead of throwing (which stalls the cursor).
            if (signal?.aborted) {
              break;
            }
            itemsSkipped++;
            // Skip individual items that fail to parse;
            // don't abort the entire page.
            continue;
          }
        }

        if (itemsSkipped > 0) {
          logger.warn("case_law.ingestion.page_items_skipped", {
            adapterKey: opts.adapterKey,
            page,
            skipped: itemsSkipped,
            total: items.length,
          });
        }

        const totalMs = Math.round(performance.now() - fetchT0);
        logger.info("case_law.ingestion.page_completed", {
          adapterKey: opts.adapterKey,
          page,
          decisions: decisions.length,
          items: items.length,
          skipped: itemsSkipped,
          totalMs,
          fetchMs,
          ...(total !== undefined && total !== null
            ? { sourceTotal: total }
            : {}),
        });

        const fetched = (page - firstPage + 1) * opts.pageSize;
        const hasMore =
          items.length >= opts.pageSize &&
          (total === undefined || total === null || fetched < total);

        // When exhausted with results, park at the current page
        // so the next cycle re-checks it for new entries.
        // Parking at page-1 causes a ping-pong: page-1 (all
        // skipped) → page (parks at page-1) → stagnation.
        //
        // When exhausted with zero results (overshot past end),
        // step back so the cursor recovers into the valid range.
        const nextCursor = hasMore
          ? String(page + 1)
          : items.length > 0
            ? String(page)
            : String(Math.max(firstPage, page - 1));

        return { decisions, nextCursor };
      },
      catch: adapterCatch(opts.adapterKey, cursor),
    });
};
