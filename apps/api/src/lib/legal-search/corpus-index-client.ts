import { panic, Result, TaggedError } from "better-result";

import {
  observeRegistryRequest,
  type RegistryRequestObservation,
} from "@stll/business-registries/shared/request-observer";
import { fetchWithTimeout, type FetchWithTimeoutInit } from "@stll/fetch";
import { Temporal } from "@stll/time";

import { envBase } from "@/api/env-base";
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

type CorpusIndexErrorRejection = "definite" | "unknown" | "transient";

/**
 * Whether the engine was there to answer. `unreachable` is a request that
 * never got an answer (refused or reset connection, failed DNS lookup, an
 * expired budget) or one a gateway in front of the engine answered for it
 * (502, 503, 504): the index is down or scaled away, and the same request can
 * succeed once it is back. `answered` is everything else, including a
 * response this client could not read, which no retry fixes.
 */
type CorpusIndexErrorReach = "answered" | "unreachable";

export class CorpusIndexError extends TaggedError("CorpusIndexError")<{
  message: string;
  status?: number | undefined;
  cause?: unknown;
  rejection: CorpusIndexErrorRejection;
  reach: CorpusIndexErrorReach;
}> {
  constructor(input: {
    message: string;
    status?: number | undefined;
    cause?: unknown;
    rejection?: CorpusIndexErrorRejection | undefined;
    reach?: CorpusIndexErrorReach | undefined;
  }) {
    super({
      ...input,
      rejection: input.rejection ?? "unknown",
      reach: input.reach ?? "answered",
    });
  }
}

/** The statuses a gateway answers with while the engine behind it is gone. */
const UNREACHABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * The one reading of "the search index is unavailable" every caller shares,
 * so a search route, a tool and a test cannot each draw the line elsewhere.
 */
export const isCorpusIndexUnreachable = (error: CorpusIndexError): boolean =>
  error.reach === "unreachable";

/**
 * Mirrors Quickwit's default ingest `content_length_limit`; our node config
 * does not set this option.
 */
export const CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES = 10 * 1024 * 1024;

const SEARCH_TIMEOUT_MS = 30_000;

/**
 * How the engine serializes a search response body. Its own default is
 * `pretty_json`, so every hit arrives indented: a newline, the nesting indent,
 * and a space after each colon, for every field of every hit. A scan round
 * reaching a few hundred passages pays that on all of them, and the parsed
 * value is identical either way.
 *
 * The search endpoint has no way to return fewer fields per hit. Quickwit
 * 0.9's `SearchRequestQueryString` declares `deny_unknown_fields` and its whole
 * surface is query / aggs / search_field / snippet_fields / start_timestamp /
 * end_timestamp / max_hits / start_offset / format / sort_by / count_all /
 * allow_failed_splits. A hit is therefore the full stored document, and the
 * body format is the only width this client controls.
 */
const SEARCH_RESPONSE_FORMAT = "json";

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
export const CORPUS_INDEX_AGGREGATION_TIMEOUT_MS = 10_000;
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
const SETTLEMENT_SPLIT_STATE_VALUES = ["Published", "Staged"] as const;
const SETTLEMENT_SPLIT_STATES = SETTLEMENT_SPLIT_STATE_VALUES.join(",");
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

type CorpusIndexCommitMode =
  (typeof CORPUS_INDEX_COMMIT)[keyof typeof CORPUS_INDEX_COMMIT];

type CorpusIndexSearchInput = {
  observer: RegistryRequestObservation;
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
  observer: RegistryRequestObservation;
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

type CorpusIndexSearchResponse = {
  numHits: number;
  hits: CorpusIndexHit[];
  snippets: Record<string, unknown>[];
};

/**
 * A best-first read of the engine's ES-compatible endpoint. It returns the
 * same `_score` order the native search does for the same query string, and
 * it can do two things that one cannot: project each hit to named stored
 * fields, and report the BM25 score beside the hit.
 */
type CorpusIndexScoredSearchInput = {
  observer: RegistryRequestObservation;
  indexId: string;
  /** Full corpus index query string, read exactly as `search` reads it. */
  query: string;
  /** Rank of the first hit returned. */
  from: number;
  size: number;
  /** Stored fields each hit carries; nothing else of the document is sent. */
  fields: readonly string[];
  /**
   * Fields every hit must carry. A hit without one of them is a malformed
   * response, not a hit to skip: a reader that skipped it would still count it
   * as read and could answer a short page while the engine reports matches.
   */
  requiredFields: readonly string[];
};

type CorpusIndexScoredHit = {
  /** The hit's stored fields, limited to the requested ones. */
  fields: CorpusIndexHit;
  /** BM25 of the hit under the query. */
  score: number;
};

export type CorpusIndexScoredSearchResponse = {
  numHits: number;
  hits: CorpusIndexScoredHit[];
};

const STORED_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/u;

/**
 * The request a scored read sends.
 *
 * `default_operator` is AND because that is what the native endpoint applies
 * to the same query string; the ES-compatible default is OR, which would widen
 * every juxtaposed pair of terms into a disjunction. The sort is spelled out
 * so the score arrives in each hit's `sort` value, and the hit count is
 * tracked exactly because the scan decides whether to continue from it.
 */
export const corpusIndexScoredSearchRequest = ({
  indexId,
  query,
  from,
  size,
  fields,
  requiredFields,
}: CorpusIndexScoredSearchInput): {
  path: string;
  body: Record<string, unknown>;
} => {
  if (fields.length === 0) {
    panic("A scored corpus search must name the fields it reads");
  }
  for (const field of requiredFields) {
    if (!fields.includes(field)) {
      panic(`A scored corpus search requires ${field} without reading it`);
    }
  }
  for (const field of fields) {
    if (!STORED_FIELD_NAME.test(field)) {
      panic(`Invalid stored field name for a scored search: ${field}`);
    }
  }
  return {
    path: `/api/v1/_elastic/${indexId}/_search?_source_includes=${fields.join(",")}`,
    body: {
      query: { query_string: { query, default_operator: "AND" } },
      from,
      size,
      sort: [{ _score: { order: "desc" } }],
      track_total_hits: true,
    },
  };
};

const scoreOfScoredHit = (hit: Record<string, unknown>): number | null => {
  const sort = hit["sort"];
  const fromSort: unknown = Array.isArray(sort) ? sort.at(0) : undefined;
  const score = typeof fromSort === "number" ? fromSort : hit["_score"];
  return typeof score === "number" && Number.isFinite(score) ? score : null;
};

/**
 * Null when the body is not the shape the endpoint documents, including a hit
 * whose `_source` is missing or null, or lacks one of `requiredFields`.
 */
export const parseCorpusIndexScoredSearchResponse = (
  response: unknown,
  requiredFields: readonly string[],
): CorpusIndexScoredSearchResponse | null => {
  const outer = isRecord(response) ? response["hits"] : undefined;
  if (!isRecord(outer)) {
    return null;
  }
  const total = outer["total"];
  const numHits = isRecord(total) ? total["value"] : undefined;
  const rawHits = parseRecordArray(outer["hits"]);
  if (
    typeof numHits !== "number" ||
    !Number.isFinite(numHits) ||
    numHits < 0 ||
    rawHits === null
  ) {
    return null;
  }
  const hits: CorpusIndexScoredHit[] = [];
  for (const hit of rawHits) {
    const source = hit["_source"];
    const score = scoreOfScoredHit(hit);
    if (
      !isRecord(source) ||
      score === null ||
      requiredFields.some(
        (field) => source[field] === undefined || source[field] === null,
      )
    ) {
      return null;
    }
    hits.push({ fields: source, score });
  }
  return { numHits, hits };
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

type CorpusIndexDeleteSettlementTask = {
  requiredOpstamp: number;
  /**
   * The delete task's metastore creation instant, for a caller that retained
   * it. A split first published after that instant is excluded from the
   * proof; `null` keeps every observed split in it.
   */
  deleteCreatedAt: Temporal.Instant | null;
};

type CorpusIndexDeleteSettlementsInput = {
  observer: RegistryRequestObservation;
  indexId: string;
  /** Delete tasks of this one index, all judged against one split read. */
  tasks: readonly CorpusIndexDeleteSettlementTask[];
};

/**
 * Whether the engine applies delete tasks to a split yet. Quickwit applies
 * them to mature splits only; an immature split matures at `maturesAt`, its
 * creation instant plus the merge policy's maturation period, in the
 * metastore's whole seconds.
 */
type CorpusIndexSplitMaturity =
  | { type: "mature" }
  | { type: "immature"; maturesAt: Temporal.Instant };

/** One split's delete progress, as the pass a settlement is judged on read it. */
export type CorpusIndexSettlementSplit = {
  splitId: string;
  state: (typeof SETTLEMENT_SPLIT_STATE_VALUES)[number];
  /** The highest delete-task opstamp the split has had applied. */
  appliedOpstamp: number;
  /** Null while the split has never been published. */
  publishedAt: Temporal.Instant | null;
  maturity: CorpusIndexSplitMaturity;
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
  /** The proving splits still below the required opstamp, `laggingSplits` of them. */
  laggingProvingSplits: readonly CorpusIndexSettlementSplit[];
  /**
   * Excluded splits still below the required opstamp. They hold no targeted
   * revision of their own, but a merge output or a split from an indexing
   * run that started before the task can carry one, and the engine applies
   * the task to them like to any other split. A split the task can never
   * reach was created after it, so its opstamp is at or above the task's.
   */
  laggingExcludedSplits: readonly CorpusIndexSettlementSplit[];
};

export type CorpusIndexDeleteSettlementRead = Result<
  CorpusIndexDeleteSettlement,
  CorpusIndexError
>;

/** Result of checking one immutable manifest against its physical index. */
type CorpusIndexConfigAttestation =
  | { status: "missing" }
  | { status: "matching"; indexUri: string };

export type CorpusIndexClient = {
  createIndex: (
    config: CorpusIndexConfig,
    observer: RegistryRequestObservation,
  ) => Promise<Result<void, CorpusIndexError>>;
  deleteIndex: (
    indexId: string,
    observer: RegistryRequestObservation,
  ) => Promise<Result<void, CorpusIndexError>>;
  indexExists: (
    indexId: string,
    observer: RegistryRequestObservation,
  ) => Promise<Result<boolean, CorpusIndexError>>;
  /**
   * Read the engine's materialized config and compare every manifest-pinned
   * value. Quickwit adds defaults and a random doc-mapping UID to the GET
   * response, so raw-object equality is not a valid contract check.
   */
  attestIndexConfig: (
    config: CorpusIndexConfig,
    observer: RegistryRequestObservation,
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
    observer: RegistryRequestObservation,
  ) => Promise<Result<void, CorpusIndexError>>;
  /** Final-generation append: durable commit plus an exact V2 receipt. */
  ingestCommittedBatch: (
    indexId: string,
    ndjson: string,
    observer: RegistryRequestObservation,
  ) => Promise<Result<void, CorpusIndexError>>;
  /**
   * Final-generation append that returns on acceptance instead of on the
   * commit, with the same exact V2 receipt. Throughput path only: the
   * caller owns the publish fence every observer of the acceptance needs.
   */
  ingestQueuedBatch: (
    indexId: string,
    ndjson: string,
    observer: RegistryRequestObservation,
  ) => Promise<Result<void, CorpusIndexError>>;
  search: (
    input: CorpusIndexSearchInput,
  ) => Promise<Result<CorpusIndexSearchResponse, CorpusIndexError>>;
  /** `_score` order with scores and projected fields; see the input type. */
  scoredSearch: (
    input: CorpusIndexScoredSearchInput,
  ) => Promise<Result<CorpusIndexScoredSearchResponse, CorpusIndexError>>;
  aggregate: (
    input: CorpusIndexAggregateInput,
  ) => Promise<Result<CorpusIndexAggregations, CorpusIndexError>>;
  deleteByQuery: (
    indexId: string,
    query: string,
    observer: RegistryRequestObservation,
  ) => Promise<Result<CorpusIndexDeleteTask, CorpusIndexError>>;
  /**
   * One settlement per task, in task order, from one shared read of the
   * index's split list. A failed read fails the call; a task whose own proof
   * cannot settle fails alone.
   */
  readDeleteSettlements: (
    input: CorpusIndexDeleteSettlementsInput,
  ) => Promise<Result<CorpusIndexDeleteSettlementRead[], CorpusIndexError>>;
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

/** The configured search endpoint, or null when neither env names one. */
export const readCorpusIndexSearchBaseUrl = (
  cluster: QuickwitCluster,
): string | null => {
  const { mutationEnv, searchEnv } = CORPUS_INDEX_CLUSTER_CONFIG[cluster];
  const value = envBase[searchEnv] ?? envBase[mutationEnv];
  if (value === undefined || value.length === 0) {
    return null;
  }
  return value.replace(/(?<!\/)\/+$/u, "");
};

const searchBaseUrl = (cluster: QuickwitCluster): string => {
  const value = readCorpusIndexSearchBaseUrl(cluster);
  if (value === null) {
    const { mutationEnv, searchEnv } = CORPUS_INDEX_CLUSTER_CONFIG[cluster];
    panic(`${searchEnv} or ${mutationEnv} is required for ${cluster} search`);
  }
  return value;
};

/**
 * The client's one outbound boundary: every request is a Stella-built path
 * on one of the configured corpus index cluster URLs.
 */
const fetchCorpusIndex = async (
  baseUrl: string,
  path: string,
  init: FetchWithTimeoutInit,
  observer: RegistryRequestObservation,
): Promise<Response> => {
  init.signal?.throwIfAborted();
  observeRegistryRequest(observer);
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- baseUrl is one of the configured corpus index cluster URLs; path is Stella-built
  return await fetchWithTimeout(`${baseUrl}${path}`, init);
};

/** Liveness of the cluster's search endpoint; resolves with the raw response. */
export const probeCorpusIndexSearchLiveness = async (
  cluster: QuickwitCluster,
  timeoutMs: number,
  observer: RegistryRequestObservation,
): Promise<Response> =>
  await fetchCorpusIndex(
    searchBaseUrl(cluster),
    "/health/livez",
    {
      timeoutMs,
    },
    observer,
  );

const toCorpusIndexError = (error: unknown): CorpusIndexError =>
  error instanceof CorpusIndexError
    ? error
    : new CorpusIndexError({
        message:
          error instanceof Error
            ? error.message
            : "corpus index request failed",
        cause: error,
        rejection: "unknown",
      });

const rejectionForHttpStatus = (
  status: number,
): "definite" | "unknown" | "transient" => {
  if (status === 400 || status === 413 || status === 422) {
    return "definite";
  }
  if (status === 429 || status === 408) {
    return "transient";
  }
  return "unknown";
};

type CorpusIndexRequest = {
  observer: RegistryRequestObservation;
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
  reach,
}: RequestFailureOptions & {
  reach: CorpusIndexErrorReach;
}): CorpusIndexError =>
  new CorpusIndexError({
    message: isAborted(error)
      ? `corpus index ${requestLabel(request)} failed within its ${request.timeoutMs}ms budget: ${String(error)}`
      : `corpus index ${requestLabel(request)} ${unaborted}: ${String(error)}`,
    cause: error,
    rejection: "unknown",
    reach,
  });

/**
 * A body that stopped arriving (the budget expired or the connection dropped
 * mid-stream) is the engine going away; a body that arrived and does not
 * parse is a response, and a retry reads the same bytes.
 */
const bodyReadReach = (error: unknown): CorpusIndexErrorReach =>
  error instanceof SyntaxError ? "answered" : "unreachable";

const sendRequest = async (request: CorpusIndexRequest): Promise<Response> =>
  await fetchCorpusIndex(
    request.baseUrl,
    request.path,
    {
      ...request.init,
      timeoutMs: request.timeoutMs,
    },
    request.observer,
  ).catch((error: unknown) => {
    // `fetch` rejects only when no response arrived: refused or reset
    // connection, failed DNS lookup, expired budget.
    throw requestFailure({
      request,
      error,
      unaborted: "could not be sent",
      reach: "unreachable",
    });
  });

const requestJson = async (request: CorpusIndexRequest): Promise<unknown> => {
  const response = await sendRequest(request);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CorpusIndexError({
      message: `corpus index ${requestLabel(request)} -> ${response.status}: ${body.slice(0, 500)}`,
      status: response.status,
      rejection: rejectionForHttpStatus(response.status),
      reach: UNREACHABLE_HTTP_STATUSES.has(response.status)
        ? "unreachable"
        : "answered",
    });
  }
  return await response.json().catch((error: unknown) => {
    throw requestFailure({
      request,
      error,
      unaborted: "returned an unreadable body",
      reach: bodyReadReach(error),
    });
  });
};

type SettlementSplit = {
  evidence: CorpusIndexSettlementSplit;
  /** Null while the split has never been published. */
  publishedAtSeconds: number | null;
};

/** One complete offset scan of an index's split list, as read. */
type SplitPass = readonly SettlementSplit[];

/**
 * One pass read through one delete task's exclusion instant. A split shifting
 * between offset pages can be read twice in one pass, so each map keeps the
 * reading with the lowest opstamp the pass saw for the split.
 */
type ProvingView = {
  provingSplits: Map<string, CorpusIndexSettlementSplit>;
  excludedSplits: number;
  excluded: Map<string, CorpusIndexSettlementSplit>;
};

const invalidSplitList = (): never => {
  throw new CorpusIndexError({
    message: "corpus index split list returned an invalid response",
  });
};

const isMetastoreSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const fromMetastoreSeconds = (seconds: number): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(seconds * METASTORE_TIMESTAMP_UNIT_MS);

/** Null while the split has never been published. */
const parseSplitPublishedAtSeconds = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return isMetastoreSeconds(value) ? value : invalidSplitList();
};

/**
 * Quickwit's `SplitMaturity`: `{"type": "mature"}`, or `{"type": "immature",
 * "maturation_period_millis": n}` counted from the split's
 * `create_timestamp`. The engine adds the period's whole seconds, so the
 * instant does too.
 */
const parseSplitMaturity = (
  split: Record<string, unknown>,
): CorpusIndexSplitMaturity => {
  const maturity = split["maturity"];
  if (!isRecord(maturity)) {
    return invalidSplitList();
  }
  if (maturity["type"] === "mature") {
    return { type: "mature" };
  }
  const periodMillis = maturity["maturation_period_millis"];
  const createdAtSeconds = split["create_timestamp"];
  if (
    maturity["type"] !== "immature" ||
    !isMetastoreSeconds(periodMillis) ||
    !isMetastoreSeconds(createdAtSeconds)
  ) {
    return invalidSplitList();
  }
  return {
    type: "immature",
    maturesAt: fromMetastoreSeconds(
      createdAtSeconds + Math.floor(periodMillis / METASTORE_TIMESTAMP_UNIT_MS),
    ),
  };
};

const isSettlementSplitState = (
  value: unknown,
): value is CorpusIndexSettlementSplit["state"] =>
  SETTLEMENT_SPLIT_STATE_VALUES.some((state) => state === value);

const parseSettlementSplit = (
  split: Record<string, unknown>,
): SettlementSplit => {
  const publishedAtSeconds = parseSplitPublishedAtSeconds(
    split["publish_timestamp"],
  );
  const splitId = split["split_id"];
  const appliedOpstamp = split["delete_opstamp"];
  const state = split["split_state"];
  if (
    !isSettlementSplitState(state) ||
    typeof splitId !== "string" ||
    splitId.length === 0 ||
    typeof appliedOpstamp !== "number" ||
    !Number.isSafeInteger(appliedOpstamp) ||
    appliedOpstamp < 0
  ) {
    return invalidSplitList();
  }
  return {
    evidence: {
      splitId,
      state,
      appliedOpstamp,
      publishedAt:
        publishedAtSeconds === null
          ? null
          : fromMetastoreSeconds(publishedAtSeconds),
      maturity: parseSplitMaturity(split),
    },
    publishedAtSeconds,
  };
};

const keepLowestOpstamp = (
  splits: Map<string, CorpusIndexSettlementSplit>,
  split: CorpusIndexSettlementSplit,
): void => {
  const previous = splits.get(split.splitId);
  if (
    previous === undefined ||
    split.appliedOpstamp < previous.appliedOpstamp
  ) {
    splits.set(split.splitId, split);
  }
};

/**
 * The metastore stamps split and delete-task instants in whole seconds, so a
 * delete task's own instant is compared at that precision: a split published
 * inside the task's second stays in the proof.
 */
const toMetastoreSeconds = (instant: Temporal.Instant | null): number | null =>
  instant === null
    ? null
    : Math.floor(instant.epochMilliseconds / METASTORE_TIMESTAMP_UNIT_MS);

const provingView = (
  pass: SplitPass,
  deleteCreatedAtSeconds: number | null,
): ProvingView => {
  let excludedSplits = 0;
  const provingSplits = new Map<string, CorpusIndexSettlementSplit>();
  const excluded = new Map<string, CorpusIndexSettlementSplit>();
  for (const { evidence, publishedAtSeconds } of pass) {
    // A split published after the delete task was created is outside the
    // proof; see the settlement call site in the projection cleanup store for
    // why that is exact. A split with no publish timestamp has not been
    // published yet and stays in the proof.
    if (
      deleteCreatedAtSeconds !== null &&
      publishedAtSeconds !== null &&
      publishedAtSeconds > deleteCreatedAtSeconds
    ) {
      excludedSplits += 1;
      keepLowestOpstamp(excluded, evidence);
      continue;
    }
    keepLowestOpstamp(provingSplits, evidence);
  }
  return { provingSplits, excludedSplits, excluded };
};

/**
 * The first pass whose proving-split identities equal the pass before it (the
 * first pass is compared with an empty set), or null while none has.
 *
 * Quickwit lists by numeric offset, not a snapshot cursor. A split published
 * or retired while an earlier page is read can shift a later page, so one pass
 * can miss a split. Only a complete pass with exactly the identity set of the
 * pass before it may clear durable delete state; ongoing churn fails closed.
 * Only the proving set has to settle: an index taking continuous appends never
 * stops adding splits the proof already excludes. Since that set depends on
 * the task's instant, stability is judged per task over passes all tasks of
 * the index share.
 *
 * Opstamps come from the stabilizing pass alone. A split read before its
 * delete task landed is caught up by the time the pass that settles the
 * identity set reads it again, and carrying the earlier value forward would
 * report it as lagging for as long as the index keeps churning.
 *
 * The excluded splits are not held to that stability, so the view keeps each
 * one's latest reading from any pass up to the stabilizing one: an offset
 * shift that hid an excluded split from the last pass must not make the
 * splits the delete has still to reach look complete. A split read on both
 * sides of the instant (staged on one page, published on the next) keeps both
 * readings, so neither can hide the other's lag.
 */
const stableProvingView = (
  passes: readonly SplitPass[],
  deleteCreatedAtSeconds: number | null,
): ProvingView | null => {
  let previousSplitIds: ReadonlySet<string> = new Set();
  const excludedSeen = new Map<string, CorpusIndexSettlementSplit>();
  for (const pass of passes) {
    const view = provingView(pass, deleteCreatedAtSeconds);
    for (const [splitId, split] of view.excluded) {
      excludedSeen.set(splitId, split);
    }
    const splitIds = new Set(view.provingSplits.keys());
    if (
      splitIds.size === previousSplitIds.size &&
      splitIds.isSubsetOf(previousSplitIds)
    ) {
      return { ...view, excluded: excludedSeen };
    }
    previousSplitIds = splitIds;
  }
  return null;
};

const isValidRequiredOpstamp = (requiredOpstamp: number): boolean =>
  Number.isSafeInteger(requiredOpstamp) && requiredOpstamp >= 0;

const judgeDeleteSettlement = (
  passes: readonly SplitPass[],
  { requiredOpstamp, deleteCreatedAt }: CorpusIndexDeleteSettlementTask,
): CorpusIndexDeleteSettlementRead => {
  if (!isValidRequiredOpstamp(requiredOpstamp)) {
    return Result.err(
      new CorpusIndexError({
        message: "corpus index delete settlement received an invalid opstamp",
      }),
    );
  }
  const view = stableProvingView(passes, toMetastoreSeconds(deleteCreatedAt));
  if (view === null) {
    return Result.err(
      new CorpusIndexError({
        message:
          "corpus index split list did not reach a stable proving-split set",
      }),
    );
  }
  const isLagging = ({ appliedOpstamp }: CorpusIndexSettlementSplit) =>
    appliedOpstamp < requiredOpstamp;
  const appliedOpstamps = [...view.provingSplits.values()].map(
    ({ appliedOpstamp }) => appliedOpstamp,
  );
  const laggingProvingSplits = [...view.provingSplits.values()].filter(
    isLagging,
  );
  return Result.ok({
    requiredOpstamp,
    provingSplits: view.provingSplits.size,
    excludedSplits: view.excludedSplits,
    laggingSplits: laggingProvingSplits.length,
    minAppliedOpstamp:
      appliedOpstamps.length === 0 ? null : Math.min(...appliedOpstamps),
    settled: laggingProvingSplits.length === 0,
    laggingProvingSplits,
    laggingExcludedSplits: [...view.excluded.values()].filter(isLagging),
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

type IngestReceiptMode = "compatible" | "exact-v2";

type IngestBatchOptions = {
  observer: RegistryRequestObservation;
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
  observer,
}: IngestBatchOptions): Promise<Result<void, CorpusIndexError>> =>
  await Result.tryPromise({
    try: async () => {
      const sentDocs = ndjson
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
      const response = await requestJson({
        observer,
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
        if (sentDocs > 0 && ingested === 0 && rejected > 0) {
          throw new CorpusIndexError({
            message: `corpus index ingest rejected all ${sentDocs} documents`,
            rejection: "definite",
          });
        }
        if (
          sentDocs === 0 ||
          processing !== sentDocs ||
          ingested !== sentDocs ||
          rejectedValue !== 0
        ) {
          throw new CorpusIndexError({
            message: `corpus index ingest receipt did not commit all ${sentDocs} documents (processing=${String(processing)}, ingested=${String(ingested)}, rejected=${String(rejectedValue)})`,
            rejection: "unknown",
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
          rejection: ingested === 0 ? "definite" : "unknown",
        });
      }
      if (typeof processing === "number" && processing < sentDocs) {
        throw new CorpusIndexError({
          message: `corpus index ingest accepted ${processing} of ${sentDocs} documents`,
          rejection: "unknown",
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
  createIndex: async (config, observer) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson({
          observer,
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

  deleteIndex: async (indexId, observer) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson({
          observer,
          baseUrl: mutationBaseUrl(cluster),
          path: `/api/v1/indexes/${indexId}`,
          init: { method: "DELETE" },
          timeoutMs: ADMIN_TIMEOUT_MS,
        });
      },
      catch: toCorpusIndexError,
    }),

  indexExists: async (indexId, observer) =>
    await Result.tryPromise({
      try: async () => {
        const response = await sendRequest({
          observer,
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

  attestIndexConfig: async (config, observer) =>
    await Result.tryPromise({
      try: async () => {
        const request = {
          observer,
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
            reach: bodyReadReach(error),
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

  ingestBatch: async (indexId, ndjson, commit, observer) =>
    await ingestBatch({
      observer,
      baseUrl: mutationBaseUrl(cluster),
      indexId,
      ndjson,
      commit,
      receiptMode: "compatible",
    }),

  ingestCommittedBatch: async (indexId, ndjson, observer) =>
    await ingestBatch({
      observer,
      baseUrl: mutationBaseUrl(cluster),
      indexId,
      ndjson,
      commit: CORPUS_INDEX_COMMIT.waitFor,
      receiptMode: "exact-v2",
    }),

  ingestQueuedBatch: async (indexId, ndjson, observer) =>
    await ingestBatch({
      observer,
      baseUrl: mutationBaseUrl(cluster),
      indexId,
      ndjson,
      commit: CORPUS_INDEX_COMMIT.auto,
      receiptMode: "exact-v2",
    }),

  search: async ({
    observer,
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
          format: SEARCH_RESPONSE_FORMAT,
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
          observer,
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

  scoredSearch: async (input) =>
    await Result.tryPromise({
      try: async () => {
        const { path, body } = corpusIndexScoredSearchRequest(input);
        const response = await requestJson({
          observer: input.observer,
          baseUrl: searchBaseUrl(cluster),
          path,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          timeoutMs: SEARCH_TIMEOUT_MS,
        });
        const parsed = parseCorpusIndexScoredSearchResponse(
          response,
          input.requiredFields,
        );
        if (parsed === null) {
          throw new CorpusIndexError({
            message: "corpus index scored search returned an invalid response",
          });
        }
        return parsed;
      },
      catch: toCorpusIndexError,
    }),

  aggregate: async ({ indexId, query, aggs, observer }) =>
    await Result.tryPromise({
      try: async () => {
        const response = await requestJson({
          observer,
          baseUrl: searchBaseUrl(cluster),
          path: `/api/v1/${indexId}/search`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            // Aggregations only: hits are the expensive part of the
            // response and the caller wants counts, not documents.
            body: JSON.stringify({
              query,
              max_hits: 0,
              aggs,
              format: SEARCH_RESPONSE_FORMAT,
            }),
          },
          timeoutMs: CORPUS_INDEX_AGGREGATION_TIMEOUT_MS,
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

  deleteByQuery: async (indexId, query, observer) =>
    await Result.tryPromise({
      try: async () => {
        const response = await requestJson({
          observer,
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

  readDeleteSettlements: async ({ indexId, tasks, observer }) =>
    await Result.tryPromise({
      try: async () => {
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
        const readSplitPass = async (): Promise<SplitPass> => {
          let offset = 0;
          const pass: SettlementSplit[] = [];
          const readSplitPage = async (): Promise<void> => {
            const response = await requestJson({
              observer,
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
            if (pass.length + splits.length > MAX_SETTLEMENT_SPLITS) {
              throw new CorpusIndexError({
                message: `corpus index split list exceeds ${MAX_SETTLEMENT_SPLITS} splits`,
              });
            }
            for (const split of splits) {
              pass.push(parseSettlementSplit(split));
            }
            if (splits.length < SPLIT_PAGE_SIZE) {
              return;
            }
            offset += splits.length;
            await readSplitPage();
          };
          await readSplitPage();
          return pass;
        };
        // Every task of the index judges the same passes, so the list is read
        // only until each distinct exclusion instant has a stable proving set,
        // or the pass ceiling is reached, however many tasks share the read.
        const exclusionInstants = [
          ...new Set(
            tasks
              .filter(({ requiredOpstamp }) =>
                isValidRequiredOpstamp(requiredOpstamp),
              )
              .map(({ deleteCreatedAt }) =>
                toMetastoreSeconds(deleteCreatedAt),
              ),
          ),
        ];
        const passes: SplitPass[] = [];
        const readUntilStable = async (): Promise<void> => {
          if (
            passes.length === MAX_SETTLEMENT_SCAN_PASSES ||
            exclusionInstants.every(
              (seconds) => stableProvingView(passes, seconds) !== null,
            )
          ) {
            return;
          }
          passes.push(await readSplitPass());
          await readUntilStable();
        };
        await readUntilStable();
        return tasks.map((task) => judgeDeleteSettlement(passes, task));
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
