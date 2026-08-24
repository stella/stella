import { panic, Result, TaggedError } from "better-result";

import { envBase } from "@/api/env-base";
import { fetchWithTimeout } from "@/api/lib/fetch";
import type { CorpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Thin lazy HTTP client over corpus index's REST API. Built on first use
 * (no import-time side effects); every call has a timeout and returns a
 * typed Result. corpus index is purely the lexical first stage — the
 * citation-authority blend happens in the rerank util, not here.
 */

export class CorpusIndexError extends TaggedError("CorpusIndexError")<{
  message: string;
  status?: number | undefined;
  cause?: unknown;
}> {}

const SEARCH_TIMEOUT_MS = 30_000;

/**
 * The engine's own commit timeout for `commit=wait_for`: how long it
 * will hold the response open waiting for the split to be published.
 *
 * Stated here because the client budget has to outlast it — a client
 * that gives up first turns a commit that did happen into a batch the
 * caller retries. This is the engine's default; the index config below
 * does not override it, so raising it engine-side means raising the
 * budget with it.
 */
export const CORPUS_INDEX_COMMIT_WAIT_TIMEOUT_MS = 60_000;

/**
 * Whole-request budget for an ingest. Must exceed the commit wait above,
 * because under `wait_for` the engine only starts that wait once the
 * NDJSON upload has finished. Pinned against the commit wait in
 * `corpus-index-client.test.ts`.
 */
export const CORPUS_INDEX_INGEST_TIMEOUT_MS = 120_000;
const ADMIN_TIMEOUT_MS = 30_000;
/**
 * Tighter than search: aggregations serve page chrome (facet counts), so a
 * slow engine must give up well inside the page's own budget rather than
 * hold the request open for the full search timeout.
 */
const AGGREGATION_TIMEOUT_MS = 10_000;
const SPLIT_PAGE_SIZE = 1000;
const MAX_SETTLEMENT_SPLITS = 10_000;

/**
 * What "the engine accepted this batch" is allowed to mean.
 *
 * `auto` returns as soon as the documents are buffered for indexing, so
 * an indexer that dies inside the commit window loses them. That is
 * survivable for a bulk build, whose completeness is verified against a
 * census afterwards, and not survivable for the steady-state path: there
 * the acceptance is what lets the caller mark the row indexed in
 * Postgres, and the row is then neither missing nor stale, so nothing
 * ever selects it again. `wait_for` holds the response until the split
 * is published, which makes the acceptance mean durability.
 */
export const CORPUS_INDEX_COMMIT = {
  /** Buffered for indexing. Bulk paths only, with a census behind them. */
  auto: "auto",
  /** Published as a split. Required wherever acceptance is persisted. */
  waitFor: "wait_for",
} as const;

export type CorpusIndexCommitMode =
  (typeof CORPUS_INDEX_COMMIT)[keyof typeof CORPUS_INDEX_COMMIT];

export type CorpusIndexSearchInput = {
  indexId: string;
  /** Full corpus index query string, including any field:value filter clauses. */
  query: string;
  maxHits: number;
  startOffset?: number | undefined;
  /**
   * `sort_by` value, e.g. `_score` for BM25 (descending). Without it the
   * engine returns hits in document-id order, not relevance order.
   */
  sortBy?: string | undefined;
  snippetFields?: string[] | undefined;
};

export type CorpusIndexAggregateInput = {
  indexId: string;
  /** Full corpus index query string the aggregation runs over. */
  query: string;
  /** Engine-native aggregation request, keyed by aggregation name. */
  aggs: Record<string, unknown>;
};

/**
 * The engine's `aggregations` object, one entry per requested name. Left
 * unparsed here: bucket shape is per aggregation kind, so the caller that
 * asked for a shape is the one that can validate it.
 */
export type CorpusIndexAggregations = Record<string, unknown>;

export type CorpusIndexHit = Record<string, unknown>;

export type CorpusIndexSearchResponse = {
  numHits: number;
  hits: CorpusIndexHit[];
  snippets: Record<string, unknown>[];
};

/**
 * Durable identity of one asynchronous engine deletion.
 *
 * Quickwit applies delete tasks to published splits after accepting the
 * request. Retaining the returned opstamp is the bounded proof boundary;
 * discarding it forces operators to list the engine's ever-growing task log.
 */
export type CorpusIndexDeleteTask = {
  opstamp: number;
};

export type CorpusIndexDeleteSettlement = {
  requiredOpstamp: number;
  publishedSplits: number;
  laggingSplits: number;
  minAppliedOpstamp: number | null;
  settled: boolean;
};

export type CorpusIndexClient = {
  createIndex: (
    config: CorpusIndexConfig,
  ) => Promise<Result<void, CorpusIndexError>>;
  deleteIndex: (indexId: string) => Promise<Result<void, CorpusIndexError>>;
  indexExists: (indexId: string) => Promise<Result<boolean, CorpusIndexError>>;
  /**
   * `commit` is required rather than defaulted: the difference between
   * the two modes is whether the caller may persist the acceptance, and
   * a default would let a new call site inherit the wrong one silently.
   */
  ingestBatch: (
    indexId: string,
    ndjson: string,
    commit: CorpusIndexCommitMode,
  ) => Promise<Result<void, CorpusIndexError>>;
  search: (
    input: CorpusIndexSearchInput,
  ) => Promise<Result<CorpusIndexSearchResponse, CorpusIndexError>>;
  aggregate: (
    input: CorpusIndexAggregateInput,
  ) => Promise<Result<CorpusIndexAggregations, CorpusIndexError>>;
  deleteByQuery: (
    indexId: string,
    query: string,
  ) => Promise<Result<CorpusIndexDeleteTask, CorpusIndexError>>;
  readDeleteSettlement: (
    indexId: string,
    requiredOpstamp: number,
  ) => Promise<Result<CorpusIndexDeleteSettlement, CorpusIndexError>>;
};

const mutationBaseUrl = (): string => {
  const value = envBase.CORPUS_INDEX_ENDPOINT;
  if (value === undefined || value.length === 0) {
    panic("CORPUS_INDEX_ENDPOINT is required for corpus index mutations");
  }
  return value.replace(/(?<!\/)\/+$/u, "");
};

const searchBaseUrl = (): string => {
  const value =
    envBase.CORPUS_INDEX_SEARCH_ENDPOINT ?? envBase.CORPUS_INDEX_ENDPOINT;
  if (value === undefined || value.length === 0) {
    panic(
      "CORPUS_INDEX_SEARCH_ENDPOINT or CORPUS_INDEX_ENDPOINT is required when the corpus index search provider is selected",
    );
  }
  return value.replace(/(?<!\/)\/+$/u, "");
};

const toCorpusIndexError = (error: unknown): CorpusIndexError =>
  error instanceof CorpusIndexError
    ? error
    : new CorpusIndexError({
        message:
          error instanceof Error
            ? error.message
            : "corpus index request failed",
        cause: error,
      });

type CorpusIndexRequest = {
  baseUrl: string;
  path: string;
  init: Omit<RequestInit, "signal">;
  timeoutMs: number;
};

const requestLabel = ({ init, path }: CorpusIndexRequest): string =>
  `${init.method ?? "GET"} ${path}`;

/**
 * The budget covers the whole exchange, so it can expire before the
 * headers arrive or while the body is still streaming. Both abort with
 * the same reason, and neither is a malformed payload.
 */
const isAborted = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "TimeoutError" || error.name === "AbortError");

type RequestFailureOptions = {
  request: CorpusIndexRequest;
  error: unknown;
  /** How to describe a failure the budget did not cause. */
  unaborted: string;
};

/**
 * Names the request that failed, and the budget when the budget is what
 * ended it.
 *
 * `fetchWithTimeout` rejects with the abort reason alone, so an expired
 * budget reaches the caller as "The operation timed out." and says
 * neither which request expired nor how long it had. The rejected-status
 * branch below already names the request; this gives the branch that
 * actually fires under load the same.
 */
const requestFailure = ({
  request,
  error,
  unaborted,
}: RequestFailureOptions): CorpusIndexError =>
  new CorpusIndexError({
    message: isAborted(error)
      ? `corpus index ${requestLabel(request)} failed within its ${request.timeoutMs}ms budget: ${String(error)}`
      : `corpus index ${requestLabel(request)} ${unaborted}: ${String(error)}`,
    cause: error,
  });

const sendRequest = async (request: CorpusIndexRequest): Promise<Response> =>
  await fetchWithTimeout(`${request.baseUrl}${request.path}`, {
    ...request.init,
    timeoutMs: request.timeoutMs,
  }).catch((error: unknown) => {
    throw requestFailure({ request, error, unaborted: "could not be sent" });
  });

const requestJson = async (request: CorpusIndexRequest): Promise<unknown> => {
  const response = await sendRequest(request);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CorpusIndexError({
      message: `corpus index ${requestLabel(request)} -> ${response.status}: ${body.slice(0, 500)}`,
      status: response.status,
    });
  }
  return await response.json().catch((error: unknown) => {
    throw requestFailure({
      request,
      error,
      unaborted: "returned an unreadable body",
    });
  });
};

const parseRecordArray = (value: unknown): Record<string, unknown>[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    records.push(item);
  }
  return records;
};

const buildClient = (): CorpusIndexClient => ({
  createIndex: async (config) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson({
          baseUrl: mutationBaseUrl(),
          path: "/api/v1/indexes",
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(config),
          },
          timeoutMs: ADMIN_TIMEOUT_MS,
        });
      },
      catch: toCorpusIndexError,
    }),

  deleteIndex: async (indexId) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson({
          baseUrl: mutationBaseUrl(),
          path: `/api/v1/indexes/${indexId}`,
          init: { method: "DELETE" },
          timeoutMs: ADMIN_TIMEOUT_MS,
        });
      },
      catch: toCorpusIndexError,
    }),

  indexExists: async (indexId) =>
    await Result.tryPromise({
      try: async () => {
        const response = await sendRequest({
          baseUrl: mutationBaseUrl(),
          path: `/api/v1/indexes/${indexId}`,
          init: { method: "GET" },
          timeoutMs: ADMIN_TIMEOUT_MS,
        });
        if (response.status === 404) {
          return false;
        }
        if (!response.ok) {
          throw new CorpusIndexError({
            message: `corpus index GET /api/v1/indexes/${indexId} -> ${response.status}`,
            status: response.status,
          });
        }
        return true;
      },
      catch: toCorpusIndexError,
    }),

  ingestBatch: async (indexId, ndjson, commit) =>
    await Result.tryPromise({
      try: async () => {
        const sentDocs = ndjson
          .split("\n")
          .filter((line) => line.trim().length > 0).length;
        const response = await requestJson({
          baseUrl: mutationBaseUrl(),
          path: `/api/v1/${indexId}/ingest?commit=${commit}`,
          init: {
            method: "POST",
            headers: { "content-type": "application/x-ndjson" },
            body: ndjson,
          },
          timeoutMs: CORPUS_INDEX_INGEST_TIMEOUT_MS,
        });
        if (!isRecord(response)) {
          throw new CorpusIndexError({
            message: "corpus index ingest returned an invalid response",
          });
        }
        // The engine can accept the HTTP request while dropping documents.
        // v0.8 only reports num_docs_for_processing (per-document parse
        // failures surface in server logs, not the response); newer engines
        // report rejections explicitly. Fail the batch on any signal that
        // not every document was accepted so the backfill retries instead
        // of committing indexedHash for documents that never landed.
        let rejected = 0;
        if (typeof response["num_rejected_docs"] === "number") {
          rejected = response["num_rejected_docs"];
        } else if (Array.isArray(response["parse_failures"])) {
          rejected = response["parse_failures"].length;
        }
        if (rejected > 0) {
          throw new CorpusIndexError({
            message: `corpus index ingest rejected ${rejected} of ${sentDocs} documents`,
          });
        }
        const accepted = response["num_docs_for_processing"];
        if (typeof accepted === "number" && accepted < sentDocs) {
          throw new CorpusIndexError({
            message: `corpus index ingest accepted ${accepted} of ${sentDocs} documents`,
          });
        }
      },
      catch: toCorpusIndexError,
    }),

  search: async ({
    indexId,
    query,
    maxHits,
    startOffset,
    sortBy,
    snippetFields,
  }) =>
    await Result.tryPromise({
      try: async () => {
        const body: Record<string, unknown> = {
          query,
          max_hits: maxHits,
        };
        if (startOffset !== undefined) {
          body["start_offset"] = startOffset;
        }
        if (sortBy !== undefined) {
          body["sort_by"] = sortBy;
        }
        if (snippetFields !== undefined && snippetFields.length > 0) {
          body["snippet_fields"] = snippetFields.join(",");
        }
        const response = await requestJson({
          baseUrl: searchBaseUrl(),
          path: `/api/v1/${indexId}/search`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          timeoutMs: SEARCH_TIMEOUT_MS,
        });
        if (!isRecord(response)) {
          throw new CorpusIndexError({
            message: "corpus index search returned an invalid response",
          });
        }
        const numHits = response["num_hits"];
        const hits = parseRecordArray(response["hits"]);
        // The engine includes `snippets` only when snippet fields were
        // requested: without them a missing key carries no snippets, with
        // them a missing key is a malformed response.
        const snippetsRequested =
          snippetFields !== undefined && snippetFields.length > 0;
        const snippets =
          response["snippets"] === undefined && !snippetsRequested
            ? []
            : parseRecordArray(response["snippets"]);
        if (
          typeof numHits !== "number" ||
          !Number.isFinite(numHits) ||
          numHits < 0 ||
          hits === null ||
          snippets === null
        ) {
          throw new CorpusIndexError({
            message: "corpus index search returned an invalid response",
          });
        }
        return {
          numHits,
          hits,
          snippets,
        };
      },
      catch: toCorpusIndexError,
    }),

  aggregate: async ({ indexId, query, aggs }) =>
    await Result.tryPromise({
      try: async () => {
        const response = await requestJson({
          baseUrl: searchBaseUrl(),
          path: `/api/v1/${indexId}/search`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            // Aggregations only: hits are the expensive part of the
            // response and the caller wants counts, not documents.
            body: JSON.stringify({ query, max_hits: 0, aggs }),
          },
          timeoutMs: AGGREGATION_TIMEOUT_MS,
        });
        if (!isRecord(response) || !isRecord(response["aggregations"])) {
          throw new CorpusIndexError({
            message: "corpus index aggregation returned an invalid response",
          });
        }
        return response["aggregations"];
      },
      catch: toCorpusIndexError,
    }),

  deleteByQuery: async (indexId, query) =>
    await Result.tryPromise({
      try: async () => {
        const response = await requestJson({
          baseUrl: mutationBaseUrl(),
          path: `/api/v1/${indexId}/delete-tasks`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query }),
          },
          timeoutMs: ADMIN_TIMEOUT_MS,
        });
        if (
          !isRecord(response) ||
          typeof response["opstamp"] !== "number" ||
          !Number.isSafeInteger(response["opstamp"]) ||
          response["opstamp"] < 0
        ) {
          throw new CorpusIndexError({
            message: "corpus index delete task returned an invalid response",
          });
        }
        return { opstamp: response["opstamp"] };
      },
      catch: toCorpusIndexError,
    }),

  readDeleteSettlement: async (indexId, requiredOpstamp) =>
    await Result.tryPromise({
      try: async () => {
        if (
          !Number.isSafeInteger(requiredOpstamp) ||
          requiredOpstamp < 0
        ) {
          throw new CorpusIndexError({
            message: "corpus index delete settlement received an invalid opstamp",
          });
        }
        let offset = 0;
        let publishedSplits = 0;
        let laggingSplits = 0;
        let minAppliedOpstamp: number | null = null;
        for (;;) {
          const response = await requestJson({
            baseUrl: mutationBaseUrl(),
            path: `/api/v1/indexes/${indexId}/splits?offset=${offset}&limit=${SPLIT_PAGE_SIZE}&split_states=Published`,
            init: { method: "GET" },
            timeoutMs: ADMIN_TIMEOUT_MS,
          });
          const splits =
            isRecord(response) ? parseRecordArray(response["splits"]) : null;
          if (splits === null) {
            throw new CorpusIndexError({
              message: "corpus index split list returned an invalid response",
            });
          }
          for (const split of splits) {
            const opstamp = split["delete_opstamp"];
            if (
              split["split_state"] !== "Published" ||
              typeof opstamp !== "number" ||
              !Number.isSafeInteger(opstamp) ||
              opstamp < 0
            ) {
              throw new CorpusIndexError({
                message: "corpus index split list returned an invalid response",
              });
            }
            minAppliedOpstamp =
              minAppliedOpstamp === null
                ? opstamp
                : Math.min(minAppliedOpstamp, opstamp);
            if (opstamp < requiredOpstamp) {
              laggingSplits += 1;
            }
          }
          publishedSplits += splits.length;
          if (splits.length < SPLIT_PAGE_SIZE) {
            break;
          }
          if (publishedSplits >= MAX_SETTLEMENT_SPLITS) {
            throw new CorpusIndexError({
              message: `corpus index split list exceeds ${MAX_SETTLEMENT_SPLITS} published splits`,
            });
          }
          offset += splits.length;
        }
        return {
          requiredOpstamp,
          publishedSplits,
          laggingSplits,
          minAppliedOpstamp,
          settled: laggingSplits === 0,
        };
      },
      catch: toCorpusIndexError,
    }),
});

let cached: CorpusIndexClient | null = null;

export const getCorpusIndexClient = (): CorpusIndexClient => {
  cached ??= buildClient();
  return cached;
};
