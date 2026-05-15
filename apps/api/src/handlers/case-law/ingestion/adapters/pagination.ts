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
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
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
   * Page size used by existing bare page-number cursors.
   * New cursors are persisted as item offsets.
   */
  legacyPageSize?: number | undefined;
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
  /**
   * Max parallel parseItem calls within a single page.
   * Defaults to 1 (serial). Raise for adapters whose
   * parseItem performs detail fetches and where the
   * source can tolerate concurrent requests.
   */
  itemConcurrency?: number | undefined;
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
const OFFSET_CURSOR_PREFIX = "offset:";

const encodeOffsetCursor = (offset: number): string =>
  `${OFFSET_CURSOR_PREFIX}${offset}`;

const parseOffsetCursor = (
  cursor: string | null,
  firstPage: number,
  legacyPageSize: number,
): number => {
  if (!cursor) {
    return 0;
  }

  if (cursor.startsWith(OFFSET_CURSOR_PREFIX)) {
    return Number.parseInt(cursor.slice(OFFSET_CURSOR_PREFIX.length), 10);
  }

  const legacyPage = Number.parseInt(cursor, 10);
  return (legacyPage - firstPage) * legacyPageSize;
};

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
        const offset = parseOffsetCursor(
          cursor,
          firstPage,
          opts.legacyPageSize ?? opts.pageSize,
        );

        if (Number.isNaN(offset) || offset < 0) {
          throw new AdapterFetchError({
            message: `${opts.adapterKey}: invalid cursor`,
            adapterKey: opts.adapterKey,
            cursor,
          });
        }

        const pageIndex = Math.floor(offset / opts.pageSize);
        const page = firstPage + pageIndex;
        const pageStartOffset = pageIndex * opts.pageSize;
        const itemsAlreadyFetched = offset - pageStartOffset;

        const { url, init } = opts.buildRequest(page);
        const fetchT0 = performance.now();
        const listTimeout = opts.listTimeoutMs ?? ADAPTER_TIMEOUT.LIST;

        // fetchWithRetry handles timeout/5xx/429 with exponential
        // backoff. All page-paginated adapters inherit this.
        let response: Response;
        try {
          response = await fetchWithRetry(url, init, {
            maxRetries: SERVER_ERROR_RETRIES,
            timeoutMs: listTimeout,
            signal,
            adapterKey: opts.adapterKey,
          });
        } catch (error) {
          // Parent signal aborted: propagate for pipeline handling
          if (signal?.aborted) {
            throw error;
          }
          // Timeout after all retries: skip this page so the
          // adapter doesn't stall on a single slow page.
          // Network errors (DNS, connection refused) propagate
          // so a transient outage doesn't permanently skip pages.
          if (isTimeoutError(error)) {
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
              nextCursor: encodeOffsetCursor(pageStartOffset + opts.pageSize),
            };
          }
          throw error;
        }

        if (!response.ok) {
          // 5xx after all retries: skip this page and advance.
          // 429 is NOT skipped — it's transient throttling, not
          // a page error. The cursor stays put so the page is
          // retried in the next cycle.
          if (response.status >= 500) {
            captureError(
              new AdapterFetchError({
                message:
                  `${opts.adapterKey}: page ${page} returned ` +
                  `${response.status} after retries, skipping`,
                adapterKey: opts.adapterKey,
                cursor,
                httpStatus: response.status,
              }),
            );
            return {
              decisions: [],
              nextCursor: encodeOffsetCursor(pageStartOffset + opts.pageSize),
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
            });
            const retryResponse = await fetchWithRetry(url, init, {
              maxRetries: 1,
              timeoutMs: listTimeout,
              signal,
              adapterKey: opts.adapterKey,
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
              const detail = (() => {
                if (retryParseError instanceof SyntaxError) {
                  return `unparseable (content-type: ${retryContentType})`;
                }
                return `validation failed: ${retryParseError instanceof Error ? retryParseError.message : String(retryParseError)}`;
              })();
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
        const { items: fetchedItems, total } = opts.extractItems(data);
        const items = fetchedItems.slice(itemsAlreadyFetched);
        const decisions: IngestionResult[] = [];

        let itemsSkipped = 0;
        // Process items in parallel batches when the adapter
        // opts in via itemConcurrency. Default is serial.
        // On abort, discard the in-flight chunk's results and keep
        // processedThroughIndex at the previous chunk boundary so the
        // next cycle re-fetches and re-processes that chunk.
        // Idempotent inserts handle the resulting duplicates.
        let processedThroughIndex = 0;
        const chunkSize = Math.max(1, opts.itemConcurrency ?? 1);
        for (let i = 0; i < items.length; i += chunkSize) {
          if (signal?.aborted) {
            break;
          }
          const chunk = items.slice(i, i + chunkSize);
          const results = await Promise.allSettled(
            chunk.map(async (item) => await opts.parseItem(item, signal)),
          );
          if (signal?.aborted) {
            break;
          }
          for (const result of results) {
            if (result.status === "fulfilled") {
              if (result.value) {
                decisions.push(result.value);
              }
            } else {
              // Skip individual items that fail to parse;
              // don't abort the entire page.
              itemsSkipped++;
            }
          }
          processedThroughIndex = i + chunk.length;
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
          offset,
          skippedOffsetItems: itemsAlreadyFetched,
          decisions: decisions.length,
          items: items.length,
          skipped: itemsSkipped,
          totalMs,
          fetchMs,
          ...(total !== undefined && total !== null
            ? { sourceTotal: total }
            : {}),
        });

        const fetched = pageStartOffset + fetchedItems.length;
        const hasMore =
          fetchedItems.length >= opts.pageSize &&
          (total === undefined || total === null || fetched < total);

        // On abort, rewind to the start of the in-flight chunk so the
        // next cycle re-processes it.
        // When exhausted with results, park at the current offset
        // so the next cycle can detect stagnation without
        // re-processing the already consumed page tail.
        // When exhausted with zero results (overshot past end),
        // step back so the cursor recovers into the valid range.
        const nextCursor = (() => {
          if (signal?.aborted) {
            return encodeOffsetCursor(offset + processedThroughIndex);
          }
          if (hasMore) {
            return encodeOffsetCursor(fetched);
          }
          if (fetchedItems.length > 0) {
            return encodeOffsetCursor(offset + items.length);
          }
          return encodeOffsetCursor(
            Math.max(0, pageStartOffset - opts.pageSize),
          );
        })();

        return { decisions, nextCursor };
      },
      catch: adapterCatch(opts.adapterKey, cursor),
    });
};
