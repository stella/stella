import { panic, Result, TaggedError } from "better-result";

import { Temporal } from "@stll/time";

import { envBase } from "@/api/env-base";
import { fetchWithTimeout } from "@/api/lib/fetch";
import type { QuickwitCluster } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_COMMIT_TIMEOUT_SECS,
  type CorpusIndexConfig,
} from "@/api/lib/legal-search/corpus-index-config";
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
export const CORPUS_INDEX_COMMIT_WAIT_TIMEOUT_MS =
  CORPUS_INDEX_COMMIT_TIMEOUT_SECS * 1000;

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
const MAX_SETTLEMENT_SCAN_PASSES = 3;
const SETTLEMENT_SCAN_TIMEOUT_MS = 60_000;
/**
 * Both split states a targeted revision can be in. A staged split is either
 * an indexer split the engine has not published yet or a merge output waiting
 * to replace its inputs; leaving it out would prove a delete against a
 * snapshot the index is about to replace.
 */
const SETTLEMENT_SPLIT_STATES = "Published,Staged";
/** Quickwit stamps split and delete-task instants in whole seconds. */
const METASTORE_TIMESTAMP_UNIT_MS = 1000;

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
 *
 * A caller that persists an `auto` acceptance therefore owes two things:
 * a census that can still find documents the commit window lost, and a
 * publish fence, because the documents stay invisible to search and to
 * delete-by-query until the engine's own commit timer fires.
 */
export const CORPUS_INDEX_COMMIT = {
  /** Buffered for indexing. Needs a census and a publish fence behind it. */
  auto: "auto",
  /** Published as a split. Acceptance means durability at that instant. */
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
  /**
   * The metastore's own creation instant for the task, at its second
   * precision. Read from the engine rather than from this process's clock:
   * it is compared against split publish timestamps issued by the same
   * metastore, and a local instant would put clock skew inside that
   * comparison.
   */
  createdAt: Temporal.Instant;
};

type CorpusIndexDeleteSettlementInput = {
  indexId: string;
  requiredOpstamp: number;
  /**
   * The delete task's metastore creation instant, for a caller that retained
   * it. A split first published after that instant is excluded from the
   * proof; `null` keeps every observed split in it.
   */
  deleteCreatedAt: Temporal.Instant | null;
};

export type CorpusIndexDeleteSettlement = {
  requiredOpstamp: number;
  /**
   * Splits the proof stands on: published no later than the delete task, or
   * not published yet.
   */
  provingSplits: number;
  /**
   * Splits first published after the delete task. They are outside the proof,
   * and counting them keeps a stalled-settlement diagnostic readable.
   */
  excludedSplits: number;
  laggingSplits: number;
  minAppliedOpstamp: number | null;
  settled: boolean;
};

/** Result of checking one immutable manifest against its physical index. */
export type CorpusIndexConfigAttestation =
  | { status: "missing" }
  | { status: "matching"; indexUri: string };

export type CorpusIndexClient = {
  createIndex: (
    config: CorpusIndexConfig,
  ) => Promise<Result<void, CorpusIndexError>>;
  deleteIndex: (indexId: string) => Promise<Result<void, CorpusIndexError>>;
  indexExists: (indexId: string) => Promise<Result<boolean, CorpusIndexError>>;
  /**
   * Read the engine's materialized config and compare every manifest-pinned
   * value. Quickwit adds defaults and a random doc-mapping UID to the GET
   * response, so raw-object equality is not a valid contract check.
   */
  attestIndexConfig: (
    config: CorpusIndexConfig,
  ) => Promise<Result<CorpusIndexConfigAttestation, CorpusIndexError>>;
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
  /** Final-generation append: durable commit plus an exact V2 receipt. */
  ingestCommittedBatch: (
    indexId: string,
    ndjson: string,
  ) => Promise<Result<void, CorpusIndexError>>;
  /**
   * Final-generation append that returns on acceptance instead of on the
   * commit, with the same exact V2 receipt. Throughput path only: the
   * caller owns the publish fence every observer of the acceptance needs.
   */
  ingestQueuedBatch: (
    indexId: string,
    ndjson: string,
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
    input: CorpusIndexDeleteSettlementInput,
  ) => Promise<Result<CorpusIndexDeleteSettlement, CorpusIndexError>>;
};

type CorpusIndexEndpointEnv =
  | "CORPUS_INDEX_Q09_ENDPOINT"
  | "CORPUS_INDEX_Q09_SEARCH_ENDPOINT";

type CorpusIndexClusterConfig = {
  mutationEnv: CorpusIndexEndpointEnv;
  searchEnv: CorpusIndexEndpointEnv;
};

export const CORPUS_INDEX_CLUSTER_CONFIG = {
  q09: {
    mutationEnv: "CORPUS_INDEX_Q09_ENDPOINT",
    searchEnv: "CORPUS_INDEX_Q09_SEARCH_ENDPOINT",
  },
} as const satisfies Record<QuickwitCluster, CorpusIndexClusterConfig>;

const mutationBaseUrl = (cluster: QuickwitCluster): string => {
  const { mutationEnv } = CORPUS_INDEX_CLUSTER_CONFIG[cluster];
  const value = envBase[mutationEnv];
  if (value === undefined || value.length === 0) {
    panic(`${mutationEnv} is required for ${cluster} corpus index mutations`);
  }
  return value.replace(/(?<!\/)\/+$/u, "");
};

const searchBaseUrl = (cluster: QuickwitCluster): string => {
  const { mutationEnv, searchEnv } = CORPUS_INDEX_CLUSTER_CONFIG[cluster];
  const value = envBase[searchEnv] ?? envBase[mutationEnv];
  if (value === undefined || value.length === 0) {
    panic(`${searchEnv} or ${mutationEnv} is required for ${cluster} search`);
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

type SettlementSplit = {
  splitId: string;
  appliedOpstamp: number;
  /** Null while the split has never been published. */
  publishedAtSeconds: number | null;
};

type SettlementPass = {
  /** Lowest applied opstamp this pass read for each split inside the proof. */
  provingSplits: Map<string, number>;
  excludedSplits: number;
};

const invalidSplitList = (): never => {
  throw new CorpusIndexError({
    message: "corpus index split list returned an invalid response",
  });
};

/** Null while the split has never been published. */
const parseSplitPublishedAtSeconds = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidSplitList();
  }
  return value;
};

const parseSettlementSplit = (
  split: Record<string, unknown>,
): SettlementSplit => {
  const publishedAtSeconds = parseSplitPublishedAtSeconds(
    split["publish_timestamp"],
  );
  const splitId = split["split_id"];
  const appliedOpstamp = split["delete_opstamp"];
  const splitState = split["split_state"];
  if (
    (splitState !== "Published" && splitState !== "Staged") ||
    typeof splitId !== "string" ||
    splitId.length === 0 ||
    typeof appliedOpstamp !== "number" ||
    !Number.isSafeInteger(appliedOpstamp) ||
    appliedOpstamp < 0
  ) {
    return invalidSplitList();
  }
  return { splitId, appliedOpstamp, publishedAtSeconds };
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

type IngestReceiptMode = "compatible" | "exact-v2";

type IngestBatchOptions = {
  baseUrl: string;
  indexId: string;
  ndjson: string;
  commit: CorpusIndexCommitMode;
  receiptMode: IngestReceiptMode;
};

const ingestBatch = async ({
  baseUrl,
  indexId,
  ndjson,
  commit,
  receiptMode,
}: IngestBatchOptions): Promise<Result<void, CorpusIndexError>> =>
  await Result.tryPromise({
    try: async () => {
      const sentDocs = ndjson
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
      const response = await requestJson({
        baseUrl,
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
      const processing = response["num_docs_for_processing"];
      const ingested = response["num_ingested_docs"];
      const rejectedValue = response["num_rejected_docs"];
      const parseFailures = response["parse_failures"];
      let rejected = 0;
      if (typeof rejectedValue === "number") {
        rejected = rejectedValue;
      } else if (Array.isArray(parseFailures)) {
        rejected = parseFailures.length;
      }
      if (receiptMode === "exact-v2") {
        if (
          sentDocs === 0 ||
          processing !== sentDocs ||
          ingested !== sentDocs ||
          rejectedValue !== 0
        ) {
          throw new CorpusIndexError({
            message: `corpus index ingest receipt did not commit all ${sentDocs} documents (processing=${String(processing)}, ingested=${String(ingested)}, rejected=${String(rejectedValue)})`,
          });
        }
        return;
      }
      // The legacy engine can accept the HTTP request while dropping
      // documents. v0.8 reports fewer counters than v0.9, so this path keeps
      // the compatible checks until the old cluster is retired.
      if (rejected > 0) {
        throw new CorpusIndexError({
          message: `corpus index ingest rejected ${rejected} of ${sentDocs} documents`,
        });
      }
      if (typeof processing === "number" && processing < sentDocs) {
        throw new CorpusIndexError({
          message: `corpus index ingest accepted ${processing} of ${sentDocs} documents`,
        });
      }
    },
    catch: toCorpusIndexError,
  });

const CONFIG_TAG_FIELDS_PATH = "$.doc_mapping.tag_fields";
const isQuickwitOwnedConfigValue = (
  path: string,
  key: string,
  value: unknown,
): boolean =>
  ((path === "$" && key === "index_uri") ||
    (path === "$.doc_mapping" && key === "doc_mapping_uid")) &&
  typeof value === "string" &&
  value.length > 0;

const isStringArray = (value: readonly unknown[]): value is readonly string[] =>
  value.every((item) => typeof item === "string");

const compareConfigKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const normalizeAttestedArray = (
  path: string,
  value: readonly unknown[],
): readonly unknown[] =>
  path === CONFIG_TAG_FIELDS_PATH && isStringArray(value)
    ? value.toSorted(compareConfigKeys)
    : value;

/**
 * Quickwit 0.9 accepts `fast: true` for a text field, then returns the
 * equivalent explicit raw normalizer from the index metadata endpoint. Keep
 * the immutable manifest's shorthand stable while comparing the engine's
 * materialized representation. No other normalizer or field type is
 * equivalent.
 */
type MaterializedRawTextFastFieldOptions = {
  expectedField: Record<string, unknown>;
  observedField: Record<string, unknown>;
  key: string;
};

const isMaterializedRawTextFastField = ({
  expectedField,
  observedField,
  key,
}: MaterializedRawTextFastFieldOptions): boolean => {
  if (
    key !== "fast" ||
    expectedField["type"] !== "text" ||
    observedField["type"] !== "text" ||
    expectedField["fast"] !== true
  ) {
    return false;
  }
  const observedFast = observedField["fast"];
  return (
    isRecord(observedFast) &&
    Object.keys(observedFast).length === 1 &&
    observedFast["normalizer"] === "raw"
  );
};

/**
 * Return the first manifest-pinned value that differs from Quickwit state.
 *
 * Final manifests pin materialized engine defaults. Only server-owned values
 * such as `index_uri` and `doc_mapping_uid` are outside this comparison. Arrays
 * remain exact: an extra field mapping or tokenizer is physical schema drift.
 */
const configDifference = (
  expected: unknown,
  observed: unknown,
  path = "$",
): string | null => {
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed)) {
      return path;
    }
    const normalizedExpected = normalizeAttestedArray(path, expected);
    const normalizedObserved = normalizeAttestedArray(path, observed);
    if (normalizedExpected.length !== normalizedObserved.length) {
      return `${path}.length`;
    }
    for (const [index, expectedItem] of normalizedExpected.entries()) {
      const difference = configDifference(
        expectedItem,
        normalizedObserved.at(index),
        `${path}[${index}]`,
      );
      if (difference !== null) {
        return difference;
      }
    }
    return null;
  }
  if (isRecord(expected)) {
    if (!isRecord(observed)) {
      return path;
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (
        isMaterializedRawTextFastField({
          expectedField: expected,
          observedField: observed,
          key,
        })
      ) {
        continue;
      }
      const difference = configDifference(
        expectedValue,
        observed[key],
        `${path}.${key}`,
      );
      if (difference !== null) {
        return difference;
      }
    }
    for (const key of Object.keys(observed)) {
      if (
        Object.hasOwn(expected, key) ||
        isQuickwitOwnedConfigValue(path, key, observed[key])
      ) {
        continue;
      }
      return `${path}.${key}`;
    }
    return null;
  }
  return Object.is(expected, observed) ? null : path;
};

const buildClient = (cluster: QuickwitCluster): CorpusIndexClient => ({
  createIndex: async (config) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson({
          baseUrl: mutationBaseUrl(cluster),
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
          baseUrl: mutationBaseUrl(cluster),
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
          baseUrl: mutationBaseUrl(cluster),
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

  attestIndexConfig: async (config) =>
    await Result.tryPromise({
      try: async () => {
        const request = {
          baseUrl: mutationBaseUrl(cluster),
          path: `/api/v1/indexes/${config.index_id}`,
          init: { method: "GET" },
          timeoutMs: ADMIN_TIMEOUT_MS,
        } satisfies CorpusIndexRequest;
        const response = await sendRequest(request);
        if (response.status === 404) {
          return { status: "missing" } as const;
        }
        if (!response.ok) {
          throw new CorpusIndexError({
            message: `corpus index ${requestLabel(request)} -> ${response.status}`,
            status: response.status,
          });
        }
        const metadata = await response.json().catch((error: unknown) => {
          throw requestFailure({
            request,
            error,
            unaborted: "returned an unreadable body",
          });
        });
        if (!isRecord(metadata) || !isRecord(metadata["index_config"])) {
          throw new CorpusIndexError({
            message: "corpus index metadata omitted its index config",
          });
        }
        const observedConfig = metadata["index_config"];
        const difference = configDifference(config, observedConfig);
        if (difference !== null) {
          throw new CorpusIndexError({
            message: `corpus index ${config.index_id} configuration drift at ${difference}`,
          });
        }
        const indexUri = observedConfig["index_uri"];
        if (typeof indexUri !== "string" || indexUri.length === 0) {
          throw new CorpusIndexError({
            message: `corpus index ${config.index_id} metadata omitted its index URI`,
          });
        }
        return { status: "matching", indexUri } as const;
      },
      catch: toCorpusIndexError,
    }),

  ingestBatch: async (indexId, ndjson, commit) =>
    await ingestBatch({
      baseUrl: mutationBaseUrl(cluster),
      indexId,
      ndjson,
      commit,
      receiptMode: "compatible",
    }),

  ingestCommittedBatch: async (indexId, ndjson) =>
    await ingestBatch({
      baseUrl: mutationBaseUrl(cluster),
      indexId,
      ndjson,
      commit: CORPUS_INDEX_COMMIT.waitFor,
      receiptMode: "exact-v2",
    }),

  ingestQueuedBatch: async (indexId, ndjson) =>
    await ingestBatch({
      baseUrl: mutationBaseUrl(cluster),
      indexId,
      ndjson,
      commit: CORPUS_INDEX_COMMIT.auto,
      receiptMode: "exact-v2",
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
          baseUrl: searchBaseUrl(cluster),
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
        // requested and at least one hit exists: without either, a missing
        // key carries no snippets; with both, a missing key is a malformed
        // response.
        const snippetsExpected =
          snippetFields !== undefined &&
          snippetFields.length > 0 &&
          hits !== null &&
          hits.length > 0;
        const snippets =
          response["snippets"] === undefined && !snippetsExpected
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
          baseUrl: searchBaseUrl(cluster),
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
          baseUrl: mutationBaseUrl(cluster),
          path: `/api/v1/${indexId}/delete-tasks`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query }),
          },
          timeoutMs: ADMIN_TIMEOUT_MS,
        });
        const createdAtSeconds = isRecord(response)
          ? response["create_timestamp"]
          : null;
        if (
          !isRecord(response) ||
          typeof response["opstamp"] !== "number" ||
          !Number.isSafeInteger(response["opstamp"]) ||
          response["opstamp"] < 0 ||
          typeof createdAtSeconds !== "number" ||
          !Number.isSafeInteger(createdAtSeconds) ||
          createdAtSeconds < 0
        ) {
          throw new CorpusIndexError({
            message: "corpus index delete task returned an invalid response",
          });
        }
        return {
          opstamp: response["opstamp"],
          createdAt: Temporal.Instant.fromEpochMilliseconds(
            createdAtSeconds * METASTORE_TIMESTAMP_UNIT_MS,
          ),
        };
      },
      catch: toCorpusIndexError,
    }),

  readDeleteSettlement: async ({ indexId, requiredOpstamp, deleteCreatedAt }) =>
    await Result.tryPromise({
      try: async () => {
        if (!Number.isSafeInteger(requiredOpstamp) || requiredOpstamp < 0) {
          throw new CorpusIndexError({
            message:
              "corpus index delete settlement received an invalid opstamp",
          });
        }
        // The metastore stamps both instants in whole seconds, so the delete
        // task's own instant is compared at that precision. A split published
        // inside the task's second stays in the proof.
        const deleteCreatedAtSeconds =
          deleteCreatedAt === null
            ? null
            : Math.floor(
                deleteCreatedAt.epochMilliseconds / METASTORE_TIMESTAMP_UNIT_MS,
              );
        const deadline =
          Temporal.Now.instant().epochMilliseconds + SETTLEMENT_SCAN_TIMEOUT_MS;
        const remainingBudget = (): number => {
          const remaining = deadline - Temporal.Now.instant().epochMilliseconds;
          if (remaining <= 0) {
            throw new CorpusIndexError({
              message: `corpus index delete settlement exceeded its ${SETTLEMENT_SCAN_TIMEOUT_MS}ms budget`,
            });
          }
          return Math.min(remaining, ADMIN_TIMEOUT_MS);
        };
        let scanPasses = 0;
        const readSplitPass = async (): Promise<SettlementPass> => {
          scanPasses += 1;
          if (scanPasses > MAX_SETTLEMENT_SCAN_PASSES) {
            throw new CorpusIndexError({
              message:
                "corpus index split list did not reach a stable proving-split set",
            });
          }
          let offset = 0;
          let scannedSplits = 0;
          let excludedSplits = 0;
          // Keyed by split id; the value is the lowest opstamp this pass saw
          // for it, since a split shifting between offset pages can be read
          // twice.
          const provingSplits = new Map<string, number>();
          const readSplitPage = async (): Promise<void> => {
            const response = await requestJson({
              baseUrl: mutationBaseUrl(cluster),
              path: `/api/v1/indexes/${indexId}/splits?offset=${offset}&limit=${SPLIT_PAGE_SIZE}&split_states=${SETTLEMENT_SPLIT_STATES}`,
              init: { method: "GET" },
              timeoutMs: remainingBudget(),
            });
            const splits = isRecord(response)
              ? parseRecordArray(response["splits"])
              : null;
            if (splits === null) {
              return invalidSplitList();
            }
            scannedSplits += splits.length;
            if (scannedSplits > MAX_SETTLEMENT_SPLITS) {
              throw new CorpusIndexError({
                message: `corpus index split list exceeds ${MAX_SETTLEMENT_SPLITS} splits`,
              });
            }
            for (const split of splits) {
              const parsed = parseSettlementSplit(split);
              // A split published after the delete task was created is outside
              // the proof; see the settlement call site in the projection
              // cleanup store for why that is exact. A split with no publish
              // timestamp has not been published yet and stays in the proof.
              if (
                deleteCreatedAtSeconds !== null &&
                parsed.publishedAtSeconds !== null &&
                parsed.publishedAtSeconds > deleteCreatedAtSeconds
              ) {
                excludedSplits += 1;
                continue;
              }
              const previousOpstamp = provingSplits.get(parsed.splitId);
              provingSplits.set(
                parsed.splitId,
                previousOpstamp === undefined
                  ? parsed.appliedOpstamp
                  : Math.min(previousOpstamp, parsed.appliedOpstamp),
              );
            }
            if (splits.length < SPLIT_PAGE_SIZE) {
              return;
            }
            offset += splits.length;
            await readSplitPage();
          };
          await readSplitPage();
          return { provingSplits, excludedSplits };
        };
        const readStableSplitPass = async (
          previousPassSplitIds: ReadonlySet<string>,
        ): Promise<SettlementPass> => {
          const currentPass = await readSplitPass();
          const currentSplitIds = new Set(currentPass.provingSplits.keys());
          // Quickwit lists by numeric offset, not a snapshot cursor. A split
          // published or retired while an earlier page is read can shift a
          // later page. Only clear durable delete state after one complete
          // pass has exactly the same identity set; ongoing churn fails closed.
          // Only the proving set has to settle: an index taking continuous
          // appends never stops adding splits the proof already excludes.
          const stable =
            currentSplitIds.size === previousPassSplitIds.size &&
            currentSplitIds.isSubsetOf(previousPassSplitIds);
          if (stable) {
            return currentPass;
          }
          return await readStableSplitPass(currentSplitIds);
        };
        // Opstamps come from the stabilizing pass alone. A split read before
        // its delete task landed is caught up by the time the pass that
        // settles the identity set reads it again, and carrying the earlier
        // value forward would report it as lagging for as long as the index
        // keeps churning.
        const finalPass = await readStableSplitPass(new Set());
        const appliedOpstamps = [...finalPass.provingSplits.values()];
        const laggingSplits = appliedOpstamps.filter(
          (opstamp) => opstamp < requiredOpstamp,
        ).length;
        const minAppliedOpstamp =
          appliedOpstamps.length === 0 ? null : Math.min(...appliedOpstamps);
        return {
          requiredOpstamp,
          provingSplits: finalPass.provingSplits.size,
          excludedSplits: finalPass.excludedSplits,
          laggingSplits,
          minAppliedOpstamp,
          settled: laggingSplits === 0,
        };
      },
      catch: toCorpusIndexError,
    }),
});

const cachedClients = new Map<QuickwitCluster, CorpusIndexClient>();

export const getCorpusIndexClient = (
  cluster: QuickwitCluster,
): CorpusIndexClient => {
  const cached = cachedClients.get(cluster);
  if (cached !== undefined) {
    return cached;
  }
  const client = buildClient(cluster);
  cachedClients.set(cluster, client);
  return client;
};
