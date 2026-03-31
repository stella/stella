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
import { adapterCatch } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { captureError } from "@/api/lib/analytics";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/**
 * Options for page-number pagination (1-indexed or
 * 0-indexed). Covers: SK, PL, AT, CZ-supreme-admin,
 * EE, HR, and similar adapters.
 */
export type PagePaginationOptions<TResponse> = {
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
/** Max retries for transient 5xx errors before skipping. */
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

        // Retry on 5xx up to SERVER_ERROR_RETRIES times
        let response: Response | undefined;
        for (let attempt = 0; attempt <= SERVER_ERROR_RETRIES; attempt++) {
          response = await fetch(url, {
            ...init,
            signal: signal
              ? AbortSignal.any([
                  signal,
                  AbortSignal.timeout(ADAPTER_TIMEOUT.LIST),
                ])
              : AbortSignal.timeout(ADAPTER_TIMEOUT.LIST),
          });

          if (response.ok || response.status < 500) {
            break;
          }

          if (attempt < SERVER_ERROR_RETRIES) {
            // oxlint-disable-next-line no-console -- operational retry logging
            console.warn(
              `${opts.adapterKey}: page ${page} returned ${response.status}, retry ${attempt + 1}/${SERVER_ERROR_RETRIES}`,
            );
            await Bun.sleep(SERVER_ERROR_RETRY_DELAY_MS);
          }
        }

        if (!response) {
          throw new AdapterFetchError({
            message: `${opts.adapterKey}: no response`,
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

        const data = await opts.parseResponse(response);
        const { items, total } = opts.extractItems(data);
        const decisions: IngestionResult[] = [];

        for (const item of items) {
          try {
            const parsed = await opts.parseItem(item, signal);
            if (parsed) {
              decisions.push(parsed);
            }
          } catch (error) {
            // Re-throw abort/timeout so the pipeline
            // can detect cancellation properly.
            if (error instanceof DOMException) {
              throw error;
            }
            // Skip individual items that fail to parse;
            // don't abort the entire page.
            continue;
          }
        }

        const fetched = (page - firstPage + 1) * opts.pageSize;
        const nextCursor =
          items.length >= opts.pageSize &&
          (total === undefined || total === null || fetched < total)
            ? String(page + 1)
            : null;

        return { decisions, nextCursor };
      },
      catch: adapterCatch(opts.adapterKey, cursor),
    });
};
