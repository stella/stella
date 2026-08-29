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
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

/**
 * Options for page-number pagination (1-indexed or
 * 0-indexed). Covers: SK, PL, AT, CZ-supreme-admin,
 * EE, HR, and similar adapters.
 */
/** One ordered walk over a collection, named so a cursor can carry it. */
export type TraversalMode = {
  /** Persisted as the cursor prefix. Stable: changing it restarts the walk. */
  name: string;
  /** Request for a page within this walk. */
  buildRequest: (page: number) => { url: string; init?: RequestInit };
  /**
   * Where to continue once this walk reaches the end of the collection, or
   * null to stay in it.
   */
  followedBy: string | null;
  /**
   * How many items this walk covers before returning to its own start.
   *
   * A walk that keeps a crawl current has to stay near the head. Without a
   * bound it advances deeper into the collection every cycle and ends parked
   * at the far tail, where it sees nothing new — the same non-convergence
   * the ordered walks exist to avoid, reached from the other end.
   *
   * Omit it for a walk that is meant to cross the whole collection once,
   * which is what catching up is.
   */
  windowItems?: number | undefined;
};

/**
 * The number a publisher gives its own first page. Every endpoint numbers
 * pages from one or from zero, and which one it is is a fact about that
 * endpoint that the adapter must state rather than infer.
 *
 * Getting it wrong is silent, because a clamping endpoint answers an
 * out-of-range page with its first one instead of an error: the walk then
 * re-reads that page every traversal and reads every later page one page
 * short of where its cursor says it is.
 */
export type FirstPageNumber = 0 | 1;

type PagePaginationOptions<TResponse> = {
  /** Adapter key for error context. */
  adapterKey: string;
  /**
   * The page number this endpoint gives its first page. Cursors are item
   * offsets either way: this is only how an offset is turned into the number
   * the publisher is asked for, so the page fetched for offset `n` always
   * begins at item `n - (n % pageSize)`.
   */
  firstPage: FirstPageNumber;
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
   * Ordered walks over the same collection, where one walk cannot serve both
   * catching up and keeping up.
   *
   * A source sorted newest-first cannot be caught up by walking offsets
   * forward: every publication shifts each later offset, so items slide past
   * the cursor unseen and the crawl never converges. Walking oldest-first
   * does converge, because new items land at the end and the offsets already
   * walked never move. It is the wrong order to stay current in, though, so a
   * source needs both: oldest-first until the collection has been seen, then
   * newest-first from there on.
   *
   * The active mode is persisted in the cursor (`backfill:1200`) rather than
   * chosen per call, so a restart, a redeploy, or a second caller all resume
   * in the phase the crawl actually reached.
   *
   * Adapters that need only one walk omit this and keep `buildRequest`.
   */
  traversal?: readonly TraversalMode[] | undefined;
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
 *     firstPage: 1,
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
const CANONICAL_NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;

export const encodeOffsetCursor = (offset: number): string =>
  `${OFFSET_CURSOR_PREFIX}${offset}`;

const parseCanonicalNonNegativeSafeInteger = (value: string): number | null => {
  if (!CANONICAL_NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

type DecodeOffsetCursorParams = {
  cursor: string | null;
  firstPage: number;
  legacyPageSize: number;
};

export const decodeOffsetCursor = ({
  cursor,
  firstPage,
  legacyPageSize,
}: DecodeOffsetCursorParams): number | null => {
  if (cursor === null) {
    return 0;
  }

  if (cursor.startsWith(OFFSET_CURSOR_PREFIX)) {
    return parseCanonicalNonNegativeSafeInteger(
      cursor.slice(OFFSET_CURSOR_PREFIX.length),
    );
  }

  const legacyPage = parseCanonicalNonNegativeSafeInteger(cursor);
  if (legacyPage === null) {
    return null;
  }

  const offset = (legacyPage - firstPage) * legacyPageSize;
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
};

/**
 * The mode a cursor names and the offset within it.
 *
 * A cursor written before the adapter declared its walks names no mode. It
 * cannot be carried into one either, because an offset counted in one order
 * points somewhere unrelated in another, so the first walk restarts from its
 * beginning — which is what catching up requires anyway.
 */
export const decodeTraversalCursor = (
  cursor: string | null,
  modes: readonly TraversalMode[],
): { mode: TraversalMode; offset: number } | null => {
  const [first] = modes;
  if (first === undefined) {
    return null;
  }
  if (cursor === null) {
    return { mode: first, offset: 0 };
  }
  const separator = cursor.indexOf(":");
  const named = modes.find((mode) => mode.name === cursor.slice(0, separator));
  if (separator === -1 || named === undefined) {
    return { mode: first, offset: 0 };
  }
  const offset = parseCanonicalNonNegativeSafeInteger(
    cursor.slice(separator + 1),
  );
  return offset === null ? null : { mode: named, offset };
};

export const encodeTraversalCursor = (mode: string, offset: number): string =>
  `${mode}:${offset}`;

type ParsedPageItems = {
  decisions: IngestionResult[];
  itemsSkipped: number;
  processedThroughIndex: number;
};

type ParsePageItemsOptions = {
  adapterKey: string;
  items: unknown[];
  itemConcurrency?: number | undefined;
  page: number;
  parseItem: PagePaginationOptions<unknown>["parseItem"];
  signal?: AbortSignal | undefined;
};

const parsePageItems = async ({
  adapterKey,
  items,
  itemConcurrency,
  page,
  parseItem,
  signal,
}: ParsePageItemsOptions): Promise<ParsedPageItems> => {
  const decisions: IngestionResult[] = [];
  let itemsSkipped = 0;
  let processedThroughIndex = 0;
  const chunkSize = Math.max(1, itemConcurrency ?? 1);
  // Complete chunks sequentially so an abort can rewind to the last durable
  // chunk boundary. Replaying that chunk is safe because inserts are
  // idempotent; advancing past an in-flight chunk would lose decisions.
  for (let i = 0; i < items.length; i += chunkSize) {
    if (signal?.aborted) {
      break;
    }
    const chunk = items.slice(i, i + chunkSize);
    // oxlint-disable-next-line no-await-in-loop -- sequential chunk processing: abort/rewind bookkeeping depends on prior chunk completing
    const results = await Promise.allSettled(
      chunk.map(async (item) => await parseItem(item, signal)),
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
        // A poison item is isolated from the rest of the page. The skip is
        // counted and logged below so it remains operator-visible.
        itemsSkipped++;
      }
    }
    processedThroughIndex = i + chunk.length;
  }
  if (itemsSkipped > 0) {
    logger.warn("case_law.ingestion.page_items_skipped", {
      adapterKey,
      page,
      skipped: itemsSkipped,
      total: items.length,
    });
  }
  return { decisions, itemsSkipped, processedThroughIndex };
};

const resolveNextCursor = ({
  encode,
  fetched,
  fetchedItemsCount,
  hasMore,
  offset,
  pageSize,
  pageStartOffset,
  processedItemsCount,
  processedThroughIndex,
  signal,
}: {
  encode: (offset: number) => string;
  fetched: number;
  fetchedItemsCount: number;
  hasMore: boolean;
  offset: number;
  pageSize: number;
  pageStartOffset: number;
  processedItemsCount: number;
  processedThroughIndex: number;
  signal?: AbortSignal | undefined;
}): string => {
  if (signal?.aborted) {
    return encode(offset + processedThroughIndex);
  }
  if (hasMore) {
    return encode(fetched);
  }
  if (fetchedItemsCount > 0) {
    return encode(offset + processedItemsCount);
  }
  return encode(Math.max(0, pageStartOffset - pageSize));
};

export const createPagePaginatedFetch = <TResponse>(
  opts: PagePaginationOptions<TResponse>,
) => {
  const { firstPage } = opts;
  const modes = opts.traversal;

  return async (
    cursor: string | null,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result<SyncPage, AdapterFetchError>> =>
    await Result.tryPromise({
      try: async () => {
        const walk = modes ? decodeTraversalCursor(cursor, modes) : null;
        const offset = walk
          ? walk.offset
          : decodeOffsetCursor({
              cursor,
              firstPage,
              legacyPageSize: opts.legacyPageSize ?? opts.pageSize,
            });

        if (offset === null) {
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
        // Every cursor this call writes goes through here, including the
        // skip-ahead ones below. A bare offset written while a walk is
        // active would name no walk, and the next call would read that as
        // "start over" — one timeout would discard the whole traversal.
        const encode = walk
          ? (at: number): string => encodeTraversalCursor(walk.mode.name, at)
          : encodeOffsetCursor;

        const { url, init } = (walk?.mode ?? opts).buildRequest(page);
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
          // A slow publisher is an expected operational failure, so no
          // per-page exception capture (see the pipeline's halt path):
          // the skip is logged, and the coverage ledger records the
          // shortfall the skipped page leaves behind.
          if (isTimeoutError(error)) {
            logger.warn("case_law.ingestion.page_skipped_timeout", {
              adapterKey: opts.adapterKey,
              page: String(page),
              retries: String(SERVER_ERROR_RETRIES),
            });
            return {
              decisions: [],
              nextCursor: encode(pageStartOffset + opts.pageSize),
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
            // Same rule as the timeout skip above: a publisher-side 5xx
            // is operational, logged per page, and aggregated by the
            // coverage ledger rather than captured per attempt.
            logger.warn("case_law.ingestion.page_skipped_server_error", {
              adapterKey: opts.adapterKey,
              httpStatus: String(response.status),
              page: String(page),
            });
            return {
              decisions: [],
              nextCursor: encode(pageStartOffset + opts.pageSize),
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
              mediaType: contentType,
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
        const { items: fetchedItems, total } = opts.extractItems(data);
        const items = fetchedItems.slice(itemsAlreadyFetched);
        const parsedItems = await parsePageItems({
          adapterKey: opts.adapterKey,
          items,
          itemConcurrency: opts.itemConcurrency,
          page,
          parseItem: opts.parseItem,
          signal,
        });
        const { decisions, itemsSkipped, processedThroughIndex } = parsedItems;

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
          ...(total !== undefined ? { sourceTotal: total } : {}),
        });

        const fetched = pageStartOffset + fetchedItems.length;
        const hasMore =
          fetchedItems.length >= opts.pageSize &&
          (total === undefined || fetched < total);

        // On abort, rewind to the start of the in-flight chunk so the
        // next cycle re-processes it.
        // When exhausted with results, park at the current offset
        // so the next cycle can detect stagnation without
        // re-processing the already consumed page tail.
        // When exhausted with zero results (overshot past end),
        // step back so the cursor recovers into the valid range.
        let nextCursor = resolveNextCursor({
          encode,
          fetched,
          fetchedItemsCount: fetchedItems.length,
          hasMore,
          offset,
          pageSize: opts.pageSize,
          pageStartOffset,
          processedItemsCount: items.length,
          processedThroughIndex,
          signal,
        });

        // A bounded walk returns to its own start rather than carrying on
        // deeper. Reaching the edge of the window is not the end of
        // anything, so this is not a handover: the walk simply begins again
        // at the head, which is where the new items are.
        const windowItems = walk?.mode.windowItems;
        if (
          walk !== null &&
          windowItems !== undefined &&
          !signal?.aborted &&
          fetched >= windowItems
        ) {
          nextCursor = encodeTraversalCursor(walk.mode.name, 0);
        }

        // This walk has reached the end of the collection, so hand over to
        // the one that follows it, starting at its own beginning. Handing
        // over only here is what makes the switch a fact about the crawl
        // rather than a guess: the collection has demonstrably been seen.
        const successor = walk === null ? null : walk.mode.followedBy;
        if (
          walk !== null &&
          successor !== null &&
          !signal?.aborted &&
          !hasMore
        ) {
          logger.info("case_law.ingestion.traversal_advanced", {
            adapterKey: opts.adapterKey,
            from: walk.mode.name,
            to: successor,
            offset: fetched,
            ...(total !== undefined ? { sourceTotal: total } : {}),
          });
          nextCursor = encodeTraversalCursor(successor, 0);
        }

        return { decisions, nextCursor };
      },
      catch: adapterCatch(opts.adapterKey, cursor),
    });
};
