import { Result } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_CLUSTER_CONFIG,
  CORPUS_INDEX_COMMIT,
  CORPUS_INDEX_COMMIT_WAIT_TIMEOUT_MS,
  CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES,
  CORPUS_INDEX_INGEST_TIMEOUT_MS,
  type CorpusIndexDeleteSettlementRead,
  type CorpusIndexSettlementSplit,
  corpusIndexScoredSearchRequest,
  getCorpusIndexClient,
  parseCorpusIndexScoredSearchResponse,
} from "@/api/lib/legal-search/corpus-index-client";
import { DECISION_TIMESTAMP_FIELD } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexConfigFromManifest,
  CORPUS_INDEX_MANIFESTS,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { judgeCorpusProjectionCleanupSettlement } from "@/api/lib/legal-search/corpus-index-projection-settlement-judgement";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import {
  type CorpusSearchOrder,
  RELEVANCE_ORDER,
} from "@/api/lib/legal-search/corpus-search-order";
import { isRecord } from "@/api/lib/type-guards";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
  runObservedAction,
  type ActionCostObservation,
} from "@/api/lib/usage/action-costs/context";

// Pins the corpus-index HTTP request contract. The engine defaults search
// hits to document-id order unless `sort_by` is sent, and the rank-based
// lexical scoring in the pagination layer assumes relevance order, so a
// missing or misnamed sort parameter silently degrades search to
// id-order results. These tests stub global fetch and assert on the
// outgoing request, not on engine behaviour.

/** The metastore stamps a delete task and a split publish in whole seconds. */
const DELETE_TASK_SECONDS = 1_787_000_000;
const DELETE_TASK_CREATED_AT = Temporal.Instant.fromEpochMilliseconds(
  DELETE_TASK_SECONDS * 1000,
);

type RecordedRequest = {
  host: string;
  path: string;
  search: string;
  body: string;
};

let requests: RecordedRequest[];
let responseBody: unknown;
let responseBodyForUrl: ((url: URL) => unknown) | null;
let responseStatus: number;
const originalFetch = globalThis.fetch;
const originalQ09Endpoint = envBase.CORPUS_INDEX_Q09_ENDPOINT;
const originalQ09SearchEndpoint = envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT;

/**
 * The host an endpoint names, read from the test environment rather than
 * written out: a test that pins the port by hand drifts the moment the
 * environment moves.
 */
const hostOf = (endpoint: string | undefined): string => {
  if (endpoint === undefined) {
    throw new Error("the test environment configures no corpus index endpoint");
  }
  return new URL(endpoint).host;
};

beforeEach(() => {
  requests = [];
  responseBody = {};
  responseBodyForUrl = null;
  responseStatus = 200;
  const resolveUrl = (input: Parameters<typeof fetch>[0]): string => {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return input.url;
  };
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(resolveUrl(input));
    requests.push({
      host: url.host,
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const body =
      responseBodyForUrl === null ? responseBody : responseBodyForUrl(url);
    return new Response(JSON.stringify(body), { status: responseStatus });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: originalQ09Endpoint,
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: originalQ09SearchEndpoint,
  });
});

test("a cluster without its endpoint pair reaches no host", async () => {
  expect(CORPUS_INDEX_CLUSTER_CONFIG).toEqual({
    q09: {
      mutationEnv: "CORPUS_INDEX_Q09_ENDPOINT",
      searchEnv: "CORPUS_INDEX_Q09_SEARCH_ENDPOINT",
    },
  });
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: undefined,
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: undefined,
  });

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "case_law_v5_cs_sk",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  expect(requests).toEqual([]);
  if (result.isErr()) {
    expect(result.error.message).toContain("CORPUS_INDEX_Q09_SEARCH_ENDPOINT");
  }
});

test("q09 uses only its registered endpoint pair", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "http://localhost:7292",
  });

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "case_law_v5_cs_sk",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isOk()).toBe(true);
  expect(requests.at(0)?.host).toBe("localhost:7292");
});

test("q09 search falls back to its mutation endpoint", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: undefined,
  });

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "case_law_v5_cs_sk",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isOk()).toBe(true);
  expect(requests.at(0)?.host).toBe("localhost:7291");
});

test("q09 mutations cannot leak onto its read endpoint", async () => {
  responseBody = {
    num_docs_for_processing: 1,
    num_ingested_docs: 1,
    num_rejected_docs: 0,
  };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "http://localhost:7292",
  });

  const result = await getCorpusIndexClient("q09").ingestCommittedBatch(
    "case_law_v5_cs_sk",
    '{"document_id":"a"}',
    "unobserved",
  );

  expect(result.isOk()).toBe(true);
  expect(requests.at(0)?.host).toBe("localhost:7291");
});

const finalCaseLawConfig = () =>
  corpusIndexConfigFromManifest(
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    "case_law_v5_cs_sk",
  );

test("config attestation distinguishes a missing immutable index", async () => {
  responseStatus = 404;
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });

  const result = await getCorpusIndexClient("q09").attestIndexConfig(
    finalCaseLawConfig(),
    "unobserved",
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({ status: "missing" });
  }
});

test("config attestation accepts Quickwit-owned metadata and defaults", async () => {
  const config = finalCaseLawConfig();
  const materializedFieldMappings = config.doc_mapping.field_mappings.map(
    (field) =>
      field.type === "text" && field.fast
        ? { ...field, fast: { normalizer: "raw" } }
        : field,
  );
  expect(materializedFieldMappings).not.toEqual(
    config.doc_mapping.field_mappings,
  );
  responseBody = {
    index_uid: `${config.index_id}:01JTEST`,
    index_config: {
      ...config,
      index_uri: `s3://corpus-indexes/${config.index_id}`,
      doc_mapping: {
        ...config.doc_mapping,
        field_mappings: materializedFieldMappings,
        doc_mapping_uid: "01JTESTDOCMAPPING",
        tag_fields: config.doc_mapping.tag_fields.toReversed(),
        max_num_partitions: 200,
        index_field_presence: false,
        store_document_size: false,
      },
      indexing_settings: {
        ...config.indexing_settings,
        split_num_docs_target: 10_000_000,
        docstore_compression_level: 8,
      },
      ingest_settings: { min_shards: 1 },
      retention: null,
    },
  };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });

  const result = await getCorpusIndexClient("q09").attestIndexConfig(
    config,
    "unobserved",
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      status: "matching",
      indexUri: `s3://corpus-indexes/${config.index_id}`,
    });
  }
});

test("config attestation rejects text fast-field normalizer drift", async () => {
  const config = finalCaseLawConfig();
  responseBody = {
    index_config: {
      ...config,
      index_uri: `s3://corpus-indexes/${config.index_id}`,
      doc_mapping: {
        ...config.doc_mapping,
        doc_mapping_uid: "01JTESTDOCMAPPING",
        field_mappings: config.doc_mapping.field_mappings.map((field) =>
          field.name === "projection_revision"
            ? { ...field, fast: { normalizer: "lowercase" } }
            : field,
        ),
      },
    },
  };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });

  const result = await getCorpusIndexClient("q09").attestIndexConfig(
    config,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(
      "configuration drift at $.doc_mapping.field_mappings[1].fast",
    );
  }
});

test("config attestation rejects semantic keys omitted from a manifest", async () => {
  const config = corpusIndexConfigFromManifest(
    CORPUS_INDEX_MANIFESTS.legislation_v2,
    "legislation_v2_cze",
  );
  const { timestamp_field: expectedTimestamp, ...mappingWithoutTimestamp } =
    config.doc_mapping;
  expect(expectedTimestamp).toBeNull();
  const configWithoutTimestamp = {
    ...config,
    doc_mapping: mappingWithoutTimestamp,
  };
  responseBody = {
    index_config: {
      ...configWithoutTimestamp,
      index_uri: `s3://corpus-indexes/${config.index_id}`,
      doc_mapping: {
        ...mappingWithoutTimestamp,
        timestamp_field: "effective_date",
        doc_mapping_uid: "01JTESTDOCMAPPING",
      },
    },
  };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });

  const result = await getCorpusIndexClient("q09").attestIndexConfig(
    configWithoutTimestamp,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(
      "configuration drift at $.doc_mapping.timestamp_field",
    );
  }
});

test("config attestation fails closed on physical mapping drift", async () => {
  const config = finalCaseLawConfig();
  const fieldMappings = config.doc_mapping.field_mappings.map((field) =>
    field.name === "text" ? { ...field, tokenizer: "raw" as const } : field,
  );
  responseBody = {
    index_config: {
      ...config,
      index_uri: `s3://corpus-indexes/${config.index_id}`,
      doc_mapping: { ...config.doc_mapping, field_mappings: fieldMappings },
    },
  };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });

  const result = await getCorpusIndexClient("q09").attestIndexConfig(
    config,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("configuration drift");
    expect(result.error.message).toContain("tokenizer");
  }
});

test("config attestation rejects an extra physical field mapping", async () => {
  const config = finalCaseLawConfig();
  responseBody = {
    index_config: {
      ...config,
      index_uri: `s3://corpus-indexes/${config.index_id}`,
      doc_mapping: {
        ...config.doc_mapping,
        field_mappings: [
          ...config.doc_mapping.field_mappings,
          {
            name: "unexpected",
            type: "text",
            indexed: true,
            stored: false,
            fast: false,
          },
        ],
      },
    },
  };
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });

  const result = await getCorpusIndexClient("q09").attestIndexConfig(
    config,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("field_mappings.length");
  }
});

test("search sends the documented sort_by parameter", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
    sortBy: "_score",
  });

  expect(result.isOk()).toBe(true);
  const request = requests.at(0);
  expect(request?.host).toBe(hostOf(originalQ09SearchEndpoint));
  expect(request?.path).toBe("/api/v1/legal_corpus_v1_cze/search");
  const body: Record<string, unknown> = JSON.parse(request?.body ?? "{}");
  expect(body["sort_by"]).toBe("_score");
  // The engine ignores unknown keys, so the old misnamed parameter would
  // silently fall back to document-id order.
  expect(body).not.toHaveProperty("sort_by_field");
});

test("search asks the engine for a compact response body", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 300,
  });

  expect(result.isOk()).toBe(true);
  const body: Record<string, unknown> = JSON.parse(
    requests.at(0)?.body ?? "{}",
  );
  // The engine defaults to `pretty_json`, which indents every field of every
  // hit. A scan round returns a few hundred whole documents, so the default
  // costs the reader bytes no parser needs.
  expect(body["format"]).toBe("json");
});

test("aggregation asks the engine for a compact response body", async () => {
  responseBody = { aggregations: {} };

  const result = await getCorpusIndexClient("q09").aggregate({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    aggs: { court: { terms: { field: "court" } } },
  });

  expect(result.isOk()).toBe(true);
  const body: Record<string, unknown> = JSON.parse(
    requests.at(0)?.body ?? "{}",
  );
  expect(body["format"]).toBe("json");
  expect(body["max_hits"]).toBe(0);
});

test("search accepts a response without snippets", async () => {
  // A count-only search (`maxHits: 0`, no snippet fields) is answered
  // without a `snippets` key.
  responseBody = {
    num_hits: 1_197_000,
    hits: [],
    elapsed_time_micros: 4,
    errors: [],
  };

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "seq:0",
    maxHits: 0,
  });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.numHits).toBe(1_197_000);
    expect(result.value.snippets).toEqual([]);
  }
});

test("search rejects a response without snippets when snippet fields were requested", async () => {
  responseBody = { num_hits: 1, hits: [{ id: "a" }] };

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
    snippetFields: ["text"],
  });

  expect(result.isErr()).toBe(true);
});

test("search rejects a malformed snippets value", async () => {
  responseBody = { num_hits: 1, hits: [], snippets: "no" };

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "seq:0",
    maxHits: 0,
  });

  expect(result.isErr()).toBe(true);
});

test("search reads no snippets when snippet fields were requested and nothing matched", async () => {
  // The engine leaves `snippets` out of a zero-hit response even when
  // snippet fields were requested; that is an empty page, not a malformed one.
  responseBody = { num_hits: 0, hits: [] };

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
    snippetFields: ["text"],
  });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.numHits).toBe(0);
    expect(result.value.hits).toEqual([]);
    expect(result.value.snippets).toEqual([]);
  }
});

test("search rejects a malformed external response", async () => {
  responseBody = [];

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

test("search rejects a malformed object response", async () => {
  responseBody = { error: "index unavailable" };

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

const readSortedPage = async (order: CorpusSearchOrder) => {
  responseBody = {
    num_hits: 1,
    hits: [{ document_id: "doc-1" }],
    snippets: [{ text: ["snippet"] }],
  };

  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    limit: 10,
    order,
    parsedCursor: null,
    snippetFields: ["text"],
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (candidates) => ({
      context: null,
      groups: candidates.map((candidate) =>
        corpusSearchGroupToken(candidate.id),
      ),
      ranked: candidates.map((candidate) => ({
        id: candidate.id,
        score: candidate.score,
        lexicalScore: candidate.score,
        citationAuthority: 0,
      })),
    }),
  });
};

/**
 * Every engine call a scan makes names its order. Without one the engine
 * answers in document-id order, which is not a ranking at all, and the
 * rank-based position score the cursor is built from would be meaningless.
 */
const requestedSortOrders = (): unknown[] =>
  requests.map((request) => {
    const body: unknown = JSON.parse(request.body);
    return isRecord(body) ? body["sort_by"] : null;
  });

test("a relevance scan requests BM25 order on every call", async () => {
  await readSortedPage(RELEVANCE_ORDER);

  expect(requestedSortOrders().length).toBeGreaterThan(0);
  expect(new Set(requestedSortOrders())).toEqual(new Set(["_score"]));
});

test("a newest scan requests the timestamp field descending", async () => {
  await readSortedPage({
    type: "newest",
    timestampField: DECISION_TIMESTAMP_FIELD,
  });

  // The bare field name IS the descending form on this engine; a `-` prefix
  // reverses it. The highlight round addresses named passages and stays on
  // relevance, so the scan's own order is what this asserts.
  expect(requestedSortOrders()).toContain(DECISION_TIMESTAMP_FIELD);
  expect(requestedSortOrders()).not.toContain(`-${DECISION_TIMESTAMP_FIELD}`);
});

test("ingest fails when the engine accepts fewer documents than sent", async () => {
  responseBody = { num_docs_for_processing: 1 };

  const result = await getCorpusIndexClient("q09").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
    CORPUS_INDEX_COMMIT.waitFor,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("accepted 1 of 2");
  }
});

test("ingest fails when the engine reports rejected documents", async () => {
  responseBody = { num_docs_for_processing: 2, num_rejected_docs: 1 };

  const result = await getCorpusIndexClient("q09").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
    CORPUS_INDEX_COMMIT.waitFor,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("rejected 1 of 2");
    expect(result.error.rejection).toBe("unknown");
  }
});

test("a compatible partial receipt remains unknown", async () => {
  responseBody = {
    num_docs_for_processing: 2,
    num_ingested_docs: 1,
    num_rejected_docs: 1,
  };

  const result = await getCorpusIndexClient("q09").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
    CORPUS_INDEX_COMMIT.waitFor,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.rejection).toBe("unknown");
  }
});

test("ingest HTTP failures classify whether the batch was rejected", async () => {
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });
  for (const [status, rejection] of [
    [413, "definite"],
    [404, "unknown"],
    [429, "transient"],
    [503, "unknown"],
  ] as const) {
    responseStatus = status;
    const result = await getCorpusIndexClient("q09").ingestBatch(
      "legal_corpus_v1_cze",
      '{"document_id":"a"}',
      CORPUS_INDEX_COMMIT.waitFor,
      "unobserved",
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe(status);
      expect(result.error.rejection).toBe(rejection);
    }
  }
});

test("delete-by-query posts one document-scoped delete task", async () => {
  responseBody = { opstamp: 42, create_timestamp: DELETE_TASK_SECONDS };

  const result = await getCorpusIndexClient("q09").deleteByQuery(
    "legal_corpus_v1_cze",
    'document_id:"dec-1"',
    "unobserved",
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      opstamp: 42,
      createdAt: DELETE_TASK_CREATED_AT,
    });
  }
  // One task per document, whatever the index layout: a passage-split
  // document is removed by the same single query as a whole one, so the
  // indexer never has to know how many documents a row previously emitted.
  expect(requests).toHaveLength(1);
  const request = requests.at(0);
  expect(request?.host).toBe(hostOf(originalQ09Endpoint));
  expect(request?.path).toBe("/api/v1/legal_corpus_v1_cze/delete-tasks");
  const body: Record<string, unknown> = JSON.parse(request?.body ?? "{}");
  expect(body["query"]).toBe('document_id:"dec-1"');
});

test("delete-by-query rejects a response without a usable opstamp", async () => {
  responseBody = { create_timestamp: DELETE_TASK_SECONDS };

  const result = await getCorpusIndexClient("q09").deleteByQuery(
    "legal_corpus_v1_cze",
    'document_id:"dec-1"',
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

const MATURE = { type: "mature" } as const;

const publishedSplit = ({
  id,
  deleteOpstamp,
  publishedAtSeconds = DELETE_TASK_SECONDS - 60,
  maturity = MATURE,
}: {
  id: string;
  deleteOpstamp: number;
  publishedAtSeconds?: number;
  maturity?: Record<string, unknown>;
}) => ({
  split_id: id,
  split_state: "Published",
  delete_opstamp: deleteOpstamp,
  publish_timestamp: publishedAtSeconds,
  create_timestamp: publishedAtSeconds - 1,
  maturity,
});

const settlementSplit = ({
  id,
  deleteOpstamp,
  publishedAtSeconds = DELETE_TASK_SECONDS - 60,
}: {
  id: string;
  deleteOpstamp: number;
  publishedAtSeconds?: number;
}): CorpusIndexSettlementSplit => ({
  splitId: id,
  state: "Published",
  appliedOpstamp: deleteOpstamp,
  publishedAt: Temporal.Instant.fromEpochMilliseconds(
    publishedAtSeconds * 1000,
  ),
  maturity: MATURE,
});

type SettlementTask = {
  requiredOpstamp: number;
  deleteCreatedAt: Temporal.Instant | null;
};

const readSettlements = async (tasks: readonly SettlementTask[]) =>
  await getCorpusIndexClient("q09").readDeleteSettlements({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    tasks,
  });

const readOnlySettlement = async (
  task: SettlementTask,
): Promise<CorpusIndexDeleteSettlementRead> => {
  const read = await readSettlements([task]);
  if (read.isErr()) {
    return Result.err(read.error);
  }
  expect(read.value).toHaveLength(1);
  const settlement = read.value.at(0);
  if (settlement === undefined) {
    throw new Error("expected one settlement for one delete task");
  }
  return settlement;
};

const readSettlement = async (requiredOpstamp: number) =>
  await readOnlySettlement({
    requiredOpstamp,
    deleteCreatedAt: DELETE_TASK_CREATED_AT,
  });

test("delete settlement compares every proving split with the retained task", async () => {
  responseBody = {
    offset: 0,
    size: 3,
    splits: [
      publishedSplit({ id: "split-42", deleteOpstamp: 42 }),
      publishedSplit({ id: "split-41", deleteOpstamp: 41 }),
      publishedSplit({ id: "split-45", deleteOpstamp: 45 }),
    ],
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      requiredOpstamp: 42,
      provingSplits: 3,
      excludedSplits: 0,
      laggingSplits: 1,
      minAppliedOpstamp: 41,
      settled: false,
      laggingProvingSplits: [
        settlementSplit({ id: "split-41", deleteOpstamp: 41 }),
      ],
      laggingExcludedSplits: [],
    });
  }
  expect(requests.at(0)?.path).toBe(
    "/api/v1/indexes/legal_corpus_v1_cze/splits",
  );
  expect(requests.at(0)?.search).toBe(
    "?offset=0&limit=1000&split_states=Published,Staged",
  );
});

test("delete settlement excludes a split published after the delete task", async () => {
  responseBody = {
    splits: [
      publishedSplit({ id: "split-caught-up", deleteOpstamp: 42 }),
      // A steady append stream keeps producing these; the delete task cannot
      // have targeted a revision they alone hold.
      publishedSplit({
        id: "split-later",
        deleteOpstamp: 41,
        publishedAtSeconds: DELETE_TASK_SECONDS + 1,
      }),
    ],
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      requiredOpstamp: 42,
      provingSplits: 1,
      excludedSplits: 1,
      laggingSplits: 0,
      minAppliedOpstamp: 42,
      settled: true,
      // Outside the proof, and still below the task: the exact count decides
      // whether it holds anything the task targeted.
      laggingExcludedSplits: [
        settlementSplit({
          id: "split-later",
          deleteOpstamp: 41,
          publishedAtSeconds: DELETE_TASK_SECONDS + 1,
        }),
      ],
      laggingProvingSplits: [],
    });
  }
});

test("delete settlement keeps a split published inside the task's own second", async () => {
  responseBody = {
    splits: [
      publishedSplit({
        id: "split-same-second",
        deleteOpstamp: 41,
        publishedAtSeconds: DELETE_TASK_SECONDS,
      }),
    ],
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.excludedSplits).toBe(0);
    expect(result.value.laggingSplits).toBe(1);
    expect(result.value.settled).toBe(false);
  }
});

test("delete settlement holds a staged split inside the proof", async () => {
  responseBody = {
    splits: [
      publishedSplit({ id: "split-caught-up", deleteOpstamp: 42 }),
      {
        split_id: "split-staged",
        split_state: "Staged",
        delete_opstamp: 41,
        publish_timestamp: null,
        create_timestamp: DELETE_TASK_SECONDS - 1,
        maturity: MATURE,
      },
    ],
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.provingSplits).toBe(2);
    expect(result.value.excludedSplits).toBe(0);
    expect(result.value.laggingSplits).toBe(1);
    expect(result.value.settled).toBe(false);
  }
});

test("delete settlement settles once every proving split crossed the opstamp", async () => {
  responseBody = {
    splits: [
      publishedSplit({ id: "split-42", deleteOpstamp: 42 }),
      publishedSplit({ id: "split-45", deleteOpstamp: 45 }),
    ],
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.settled).toBe(true);
    expect(result.value.minAppliedOpstamp).toBe(42);
  }
});

test("delete settlement without a delete instant keeps every split", async () => {
  responseBody = {
    splits: [
      publishedSplit({
        id: "split-later",
        deleteOpstamp: 41,
        publishedAtSeconds: DELETE_TASK_SECONDS + 1,
      }),
    ],
  };

  const result = await readOnlySettlement({
    requiredOpstamp: 42,
    deleteCreatedAt: null,
  });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.provingSplits).toBe(1);
    expect(result.value.excludedSplits).toBe(0);
    expect(result.value.settled).toBe(false);
  }
});

test("delete settlement rejects an invalid required opstamp", async () => {
  const result = await readSettlement(-1);

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid opstamp");
  }
  expect(requests).toEqual([]);
});

test("delete settlement rejects a split without a usable delete opstamp", async () => {
  responseBody = {
    splits: [
      { split_id: "split-1", split_state: "Published", maturity: MATURE },
    ],
  };

  const result = await readSettlement(42);

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

test("delete settlement rejects a split with an unusable publish timestamp", async () => {
  responseBody = {
    splits: [
      {
        split_id: "split-1",
        split_state: "Published",
        delete_opstamp: 42,
        publish_timestamp: "2026-08-25T12:00:00Z",
        maturity: MATURE,
      },
    ],
  };

  const result = await readSettlement(42);

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

test("delete settlement reports when an immature lagging split matures", async () => {
  responseBody = {
    splits: [
      publishedSplit({ id: "split-caught-up", deleteOpstamp: 42 }),
      // A merge output published after the task: it carries the lowest
      // opstamp of its inputs, so it is still below the task, and it can hold
      // documents from before it.
      {
        split_id: "split-merged-later",
        split_state: "Published",
        delete_opstamp: 37,
        publish_timestamp: DELETE_TASK_SECONDS + 30,
        create_timestamp: DELETE_TASK_SECONDS + 20,
        // The engine adds whole seconds of the period.
        maturity: { type: "immature", maturation_period_millis: 14_400_999 },
      },
    ],
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.settled).toBe(true);
    expect(result.value.laggingProvingSplits).toEqual([]);
    expect(result.value.laggingExcludedSplits).toEqual([
      {
        splitId: "split-merged-later",
        state: "Published",
        appliedOpstamp: 37,
        publishedAt: Temporal.Instant.fromEpochMilliseconds(
          (DELETE_TASK_SECONDS + 30) * 1000,
        ),
        maturity: {
          type: "immature",
          maturesAt: Temporal.Instant.fromEpochMilliseconds(
            (DELETE_TASK_SECONDS + 20 + 14_400) * 1000,
          ),
        },
      },
    ]);
  }
});

test("delete settlement keeps an excluded split an offset shift hid from the last pass", async () => {
  let pageReads = 0;
  responseBodyForUrl = () => {
    pageReads += 1;
    return {
      splits: [
        publishedSplit({ id: "split-proving", deleteOpstamp: 42 }),
        // Read in the first pass only; the second pass decides stability, and
        // must not read as if the delete had nothing left to reach.
        ...(pageReads === 1
          ? [
              publishedSplit({
                id: "split-later",
                deleteOpstamp: 41,
                publishedAtSeconds: DELETE_TASK_SECONDS + 1,
              }),
            ]
          : []),
      ],
    };
  };

  const result = await readSettlement(42);

  expect(pageReads).toBe(2);
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.excludedSplits).toBe(0);
    expect(
      result.value.laggingExcludedSplits.map(({ splitId }) => splitId),
    ).toEqual(["split-later"]);
  }
});

test("delete settlement rejects a split without a usable maturity", async () => {
  for (const maturity of [
    undefined,
    { type: "ripe" },
    { type: "immature" },
    { type: "immature", maturation_period_millis: -1 },
  ]) {
    responseBody = {
      splits: [
        {
          split_id: "split-1",
          split_state: "Published",
          delete_opstamp: 42,
          publish_timestamp: DELETE_TASK_SECONDS - 60,
          create_timestamp: DELETE_TASK_SECONDS - 61,
          maturity,
        },
      ],
    };

    const result = await readSettlement(42);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("invalid response");
    }
  }
});

const settlementResponse = (splitCount: number) => (url: URL) => {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const pageSize = Math.min(1000, Math.max(splitCount - offset, 0));
  return {
    splits: Array.from({ length: pageSize }, (_, index) =>
      publishedSplit({ id: `split-${offset + index}`, deleteOpstamp: 42 }),
    ),
  };
};

test("delete settlement repeats an offset scan until split identities stabilize", async () => {
  let firstPageReads = 0;
  responseBodyForUrl = (url) => {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    if (offset === 0) {
      firstPageReads += 1;
      return {
        splits: Array.from({ length: 1000 }, (_, index) =>
          publishedSplit({
            id:
              firstPageReads === 1 || index > 0
                ? `split-${index}`
                : "split-new",
            deleteOpstamp: 42,
          }),
        ),
      };
    }
    return { splits: [] };
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.provingSplits).toBe(1000);
  }
  expect(firstPageReads).toBe(3);
});

test("delete settlement ignores churn among the splits it excluded", async () => {
  let pageReads = 0;
  responseBodyForUrl = () => {
    pageReads += 1;
    return {
      splits: [
        publishedSplit({ id: "split-proving", deleteOpstamp: 42 }),
        // One more append lands between the passes: the proof does not
        // depend on it, so the scan does not have to wait for it to stop.
        ...Array.from({ length: pageReads }, (_, index) =>
          publishedSplit({
            id: `split-appended-${index}`,
            deleteOpstamp: 41,
            publishedAtSeconds: DELETE_TASK_SECONDS + 1,
          }),
        ),
      ],
    };
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.provingSplits).toBe(1);
    expect(result.value.excludedSplits).toBe(2);
    expect(result.value.settled).toBe(true);
  }
  expect(pageReads).toBe(2);
});

test("delete settlement reads each split's opstamp from the pass that stabilized", async () => {
  let firstPageReads = 0;
  responseBodyForUrl = () => {
    firstPageReads += 1;
    return {
      splits: [
        publishedSplit({
          id: "split-lagging",
          // The first pass observes this split before its delete task lands.
          deleteOpstamp: firstPageReads === 1 ? 41 : 42,
        }),
        ...(firstPageReads === 1
          ? []
          : [publishedSplit({ id: "split-added", deleteOpstamp: 42 })]),
      ],
    };
  };

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      requiredOpstamp: 42,
      provingSplits: 2,
      excludedSplits: 0,
      laggingSplits: 0,
      minAppliedOpstamp: 42,
      settled: true,
      laggingProvingSplits: [],
      laggingExcludedSplits: [],
    });
  }
});

test("delete settlement accepts exactly the split ceiling", async () => {
  responseBodyForUrl = settlementResponse(10_000);

  const result = await readSettlement(42);

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.provingSplits).toBe(10_000);
    expect(result.value.settled).toBe(true);
  }
});

test("delete settlement rejects the first split beyond its ceiling", async () => {
  responseBodyForUrl = settlementResponse(10_001);

  const result = await readSettlement(42);

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("exceeds 10000");
  }
});

test("delete settlement lists an index's splits once for every task it judges", async () => {
  // Two pages per pass, and an append between passes that every task excludes.
  let firstPageReads = 0;
  responseBodyForUrl = (url) => {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    if (offset === 0) {
      firstPageReads += 1;
    }
    const pageSize = Math.min(1000, Math.max(1500 - offset, 0));
    return {
      splits: [
        ...Array.from({ length: pageSize }, (_, index) =>
          publishedSplit({ id: `split-${offset + index}`, deleteOpstamp: 42 }),
        ),
        ...(offset === 1000
          ? [
              publishedSplit({
                id: `split-appended-${firstPageReads}`,
                deleteOpstamp: 41,
                publishedAtSeconds: DELETE_TASK_SECONDS + 1,
              }),
            ]
          : []),
      ],
    };
  };
  const task = (requiredOpstamp: number): SettlementTask => ({
    requiredOpstamp,
    deleteCreatedAt: DELETE_TASK_CREATED_AT,
  });

  const one = await readSettlements([task(42)]);
  const oneTaskRequests = requests.length;
  requests = [];
  firstPageReads = 0;
  const many = await readSettlements(
    Array.from({ length: 8 }, (_, index) => task(35 + index)),
  );

  expect(one.isOk() && many.isOk()).toBe(true);
  // One stable pass pair over two pages, independent of the task count.
  expect(oneTaskRequests).toBe(4);
  expect(requests).toHaveLength(oneTaskRequests);
  if (many.isOk()) {
    expect(many.value.map((settlement) => settlement.isOk())).toEqual(
      Array.from({ length: 8 }, () => true),
    );
  }
});

const METASTORE_SECONDS_SPREAD = 2;
const PROPERTY_SPLIT_IDS = ["split-a", "split-b", "split-c", "split-d"];

type PropertySplit = {
  split_id: string;
  split_state: "Published" | "Staged";
  delete_opstamp: number;
  publish_timestamp: number | null;
  create_timestamp: number;
  maturity:
    | { type: "mature" }
    | { type: "immature"; maturation_period_millis: number };
};

const propertySplitArb: fc.Arbitrary<PropertySplit> = fc.record({
  split_id: fc.constantFrom(...PROPERTY_SPLIT_IDS),
  split_state: fc.constantFrom("Published", "Staged"),
  delete_opstamp: fc.integer({ min: 40, max: 44 }),
  publish_timestamp: fc.option(
    fc.integer({
      min: DELETE_TASK_SECONDS - METASTORE_SECONDS_SPREAD,
      max: DELETE_TASK_SECONDS + METASTORE_SECONDS_SPREAD,
    }),
    { nil: null },
  ),
  create_timestamp: fc.integer({
    min: DELETE_TASK_SECONDS - METASTORE_SECONDS_SPREAD,
    max: DELETE_TASK_SECONDS + METASTORE_SECONDS_SPREAD,
  }),
  maturity: fc.oneof(
    fc.constant({ type: "mature" as const }),
    fc.record({
      type: fc.constant("immature" as const),
      maturation_period_millis: fc.integer({ min: 0, max: 10_000 }),
    }),
  ),
});

const propertyPassArb = fc.array(propertySplitArb, { maxLength: 6 });

/**
 * A pass either churns freely or repeats the pass before it with opstamps
 * that only move forward, the shape a settling index reads as.
 */
const propertyPassesArb = fc
  .tuple(
    propertyPassArb,
    fc.array(fc.tuple(fc.boolean(), propertyPassArb), {
      minLength: 2,
      maxLength: 2,
    }),
  )
  .map(([first, rest]) => {
    const passes = [first];
    for (const [repeat, churned] of rest) {
      const previous = passes.at(-1) ?? first;
      passes.push(
        repeat
          ? previous.map(
              (
                {
                  split_id,
                  split_state,
                  delete_opstamp,
                  publish_timestamp,
                  create_timestamp,
                  maturity,
                },
                index,
              ) => ({
                split_id,
                split_state,
                publish_timestamp,
                create_timestamp,
                maturity,
                delete_opstamp: Math.max(
                  delete_opstamp,
                  churned.at(index)?.delete_opstamp ?? delete_opstamp,
                ),
              }),
            )
          : churned,
      );
    }
    return passes;
  });

const propertyTaskArb: fc.Arbitrary<SettlementTask> = fc
  .record({
    requiredOpstamp: fc.integer({ min: -1, max: 45 }),
    createdAtMs: fc.option(
      fc.integer({
        min: (DELETE_TASK_SECONDS - METASTORE_SECONDS_SPREAD) * 1000,
        max: (DELETE_TASK_SECONDS + METASTORE_SECONDS_SPREAD) * 1000 + 999,
      }),
      { nil: null },
    ),
  })
  .map(({ requiredOpstamp, createdAtMs }) => ({
    requiredOpstamp,
    deleteCreatedAt:
      createdAtMs === null
        ? null
        : Temporal.Instant.fromEpochMilliseconds(createdAtMs),
  }));

type SettlementVerdict =
  | {
      status: "settlement";
      requiredOpstamp: number;
      provingSplits: number;
      excludedSplits: number;
      laggingSplits: number;
      minAppliedOpstamp: number | null;
      settled: boolean;
      /** `id@opstamp`, sorted. */
      laggingProving: string[];
      laggingExcluded: string[];
    }
  | { status: "invalid-opstamp" }
  | { status: "unstable" };

type OracleVerdict = {
  verdict: SettlementVerdict;
  /** Split-list passes one task proved alone would have read. */
  passesRead: number;
};

const laggingKeys = (
  readings: ReadonlyMap<string, number>,
  requiredOpstamp: number,
): string[] =>
  [...readings]
    .filter(([, opstamp]) => opstamp < requiredOpstamp)
    .map(([id, opstamp]) => `${id}@${opstamp}`)
    .toSorted();

/**
 * One task proved alone against the same sequence of split-list passes: read
 * a pass, keep the splits not published after the task's second, and accept
 * the first pass whose proving identities equal the previous pass's (an empty
 * set before the first); give up after three passes. A split outside the proof
 * counts with its latest pass's lowest reading.
 */
const proveTaskAlone = (
  passes: readonly (readonly PropertySplit[])[],
  { requiredOpstamp, deleteCreatedAt }: SettlementTask,
): OracleVerdict => {
  if (!Number.isSafeInteger(requiredOpstamp) || requiredOpstamp < 0) {
    return { verdict: { status: "invalid-opstamp" }, passesRead: 0 };
  }
  const cutoff =
    deleteCreatedAt === null
      ? null
      : Math.floor(deleteCreatedAt.epochMilliseconds / 1000);
  let previousIds = JSON.stringify([]);
  const excludedLatest = new Map<string, number>();
  for (const [index, pass] of passes.slice(0, 3).entries()) {
    const proving = new Map<string, number>();
    const excludedHere = new Map<string, number>();
    let excludedSplits = 0;
    for (const split of pass) {
      if (
        cutoff !== null &&
        split.publish_timestamp !== null &&
        split.publish_timestamp > cutoff
      ) {
        excludedSplits += 1;
        excludedHere.set(
          split.split_id,
          Math.min(
            excludedHere.get(split.split_id) ?? split.delete_opstamp,
            split.delete_opstamp,
          ),
        );
        continue;
      }
      proving.set(
        split.split_id,
        Math.min(
          proving.get(split.split_id) ?? split.delete_opstamp,
          split.delete_opstamp,
        ),
      );
    }
    for (const [id, opstamp] of excludedHere) {
      excludedLatest.set(id, opstamp);
    }
    const ids = JSON.stringify([...proving.keys()].toSorted());
    if (ids === previousIds) {
      const opstamps = [...proving.values()];
      const laggingSplits = opstamps.filter(
        (opstamp) => opstamp < requiredOpstamp,
      ).length;
      return {
        verdict: {
          status: "settlement",
          requiredOpstamp,
          provingSplits: proving.size,
          excludedSplits,
          laggingSplits,
          minAppliedOpstamp:
            opstamps.length === 0 ? null : Math.min(...opstamps),
          settled: laggingSplits === 0,
          laggingProving: laggingKeys(proving, requiredOpstamp),
          laggingExcluded: laggingKeys(excludedLatest, requiredOpstamp),
        },
        passesRead: index + 1,
      };
    }
    previousIds = ids;
  }
  return { verdict: { status: "unstable" }, passesRead: 3 };
};

const verdictOf = (
  read: CorpusIndexDeleteSettlementRead,
): SettlementVerdict => {
  if (read.isOk()) {
    const { laggingProvingSplits, laggingExcludedSplits, ...counts } =
      read.value;
    const keys = (splits: readonly CorpusIndexSettlementSplit[]) =>
      splits
        .map(({ splitId, appliedOpstamp }) => `${splitId}@${appliedOpstamp}`)
        .toSorted();
    return {
      status: "settlement",
      ...counts,
      laggingProving: keys(laggingProvingSplits),
      laggingExcluded: keys(laggingExcludedSplits),
    };
  }
  if (read.error.message.includes("invalid opstamp")) {
    return { status: "invalid-opstamp" };
  }
  if (read.error.message.includes("stable proving-split set")) {
    return { status: "unstable" };
  }
  throw read.error;
};

test("delete settlements judged together match each task judged alone", async () => {
  await assertProperty(
    "delete settlements judged together match each task judged alone",
    fc.asyncProperty(
      propertyPassesArb,
      fc.array(propertyTaskArb, { minLength: 1, maxLength: 8 }),
      async (passes, tasks) => {
        requests = [];
        let passesServed = 0;
        responseBodyForUrl = () => {
          passesServed += 1;
          const pass = passes.at(passesServed - 1);
          if (pass === undefined) {
            throw new Error("settlement read more passes than the ceiling");
          }
          return { splits: pass };
        };

        const read = await readSettlements(tasks);

        if (read.isErr()) {
          throw read.error;
        }
        const alone = tasks.map((task) => proveTaskAlone(passes, task));
        expect(read.value.map(verdictOf)).toEqual(
          alone.map(({ verdict }) => verdict),
        );
        // The shared read stops where the most demanding task alone would.
        expect(requests).toHaveLength(
          Math.max(0, ...alone.map(({ passesRead }) => passesRead)),
        );
      },
    ),
  );
});

const SURVIVOR_CONFIRMED_LONG_AGO = Temporal.Instant.fromEpochMilliseconds(0);

/**
 * Tasks inside the generated opstamp range with a retained instant: the
 * region where some splits crossed the task and some did not, on both sides
 * of the exclusion instant.
 */
const straddlingTaskArb: fc.Arbitrary<SettlementTask> = fc
  .record({
    requiredOpstamp: fc.integer({ min: 41, max: 44 }),
    createdAtMs: fc.integer({
      min: (DELETE_TASK_SECONDS - METASTORE_SECONDS_SPREAD) * 1000,
      max: (DELETE_TASK_SECONDS + METASTORE_SECONDS_SPREAD) * 1000 + 999,
    }),
  })
  .map(({ requiredOpstamp, createdAtMs }) => ({
    requiredOpstamp,
    deleteCreatedAt: Temporal.Instant.fromEpochMilliseconds(createdAtMs),
  }));

test("a survivor is declared only when every split the settling pass read crossed the opstamp", async () => {
  await assertProperty(
    "a survivor is declared only when every split the settling pass read crossed the opstamp",
    fc.asyncProperty(
      propertyPassesArb,
      fc.oneof(straddlingTaskArb, propertyTaskArb),
      async (passes, task) => {
        let passesServed = 0;
        responseBodyForUrl = () => {
          passesServed += 1;
          return { splits: passes.at(passesServed - 1) ?? [] };
        };

        const read = await readSettlements([task]);

        if (read.isErr()) {
          throw read.error;
        }
        const settlement = read.value.at(0);
        if (settlement === undefined || settlement.isErr()) {
          return;
        }
        const judgement = judgeCorpusProjectionCleanupSettlement({
          settlement: settlement.value,
          // Something of the revisions is still in the index.
          remainingRevisionCount: 1,
          now: DELETE_TASK_CREATED_AT,
          survivorConfirmableAt: SURVIVOR_CONFIRMED_LONG_AGO,
        });
        const declared =
          judgement.type === "pending" &&
          judgement.pending.reason === "survivor";
        const { passesRead } = proveTaskAlone(passes, task);
        const crossed = (pass: readonly PropertySplit[]) =>
          pass.every(
            ({ delete_opstamp }) => delete_opstamp >= task.requiredOpstamp,
          );
        // Every split any read pass held crossed the opstamp, so nothing the
        // delete can still reach holds what the count found.
        if (passes.slice(0, passesRead).every(crossed)) {
          expect(declared).toBe(true);
        }
        if (declared) {
          expect(crossed(passes.at(passesRead - 1) ?? [])).toBe(true);
        }
      },
    ),
  );
});

test("ingest sends the commit mode the caller asked for", async () => {
  responseBody = { num_docs_for_processing: 1 };

  for (const commit of Object.values(CORPUS_INDEX_COMMIT)) {
    await getCorpusIndexClient("q09").ingestBatch(
      "legal_corpus_v1_cze",
      '{"document_id":"a"}',
      commit,
      "unobserved",
    );
  }

  // The mode decides whether the response means "buffered" or "committed",
  // and the caller persists the acceptance on the strength of it. A mode
  // dropped on the way to the URL would put the durable meaning back to
  // `auto` with nothing to notice.
  expect(requests.map(({ search }) => search)).toEqual(
    Object.values(CORPUS_INDEX_COMMIT).map((mode) => `?commit=${mode}`),
  );
});

test("the ingest budget outlasts the engine's commit wait", () => {
  // Under `wait_for` the engine holds the response for up to its own
  // commit timeout, and only starts counting once the NDJSON upload is
  // done. A client that gives up first turns a commit that did happen
  // into a batch the caller retries — and, for the steady-state path,
  // into a row it never marks indexed.
  expect(CORPUS_INDEX_INGEST_TIMEOUT_MS).toBeGreaterThan(
    CORPUS_INDEX_COMMIT_WAIT_TIMEOUT_MS,
  );
});

test("the published ingest content limit is Quickwit's 10 MiB boundary", () => {
  expect(CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES).toBe(10 * 1024 * 1024);
});

test("ingest succeeds when every document is accepted", async () => {
  responseBody = { num_docs_for_processing: 2 };

  const result = await getCorpusIndexClient("q09").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
    CORPUS_INDEX_COMMIT.waitFor,
    "unobserved",
  );

  expect(result.isOk()).toBe(true);
});

test("final-generation ingest requires the exact committed V2 receipt", async () => {
  responseBody = {
    num_docs_for_processing: 2,
    num_ingested_docs: 2,
    num_rejected_docs: 0,
  };

  const result = await getCorpusIndexClient("q09").ingestCommittedBatch(
    "case_law_v5_cs_sk",
    '{"document_id":"a"}\n{"document_id":"b"}',
    "unobserved",
  );

  expect(result.isOk()).toBe(true);
  expect(requests.at(0)?.search).toBe("?commit=wait_for");
});

test("the two final-generation ingests differ only in their commit mode", async () => {
  responseBody = {
    num_docs_for_processing: 2,
    num_ingested_docs: 2,
    num_rejected_docs: 0,
  };
  const client = getCorpusIndexClient("q09");
  const ndjson = '{"document_id":"a"}\n{"document_id":"b"}';

  expect(
    (
      await client.ingestCommittedBatch(
        "case_law_v5_cs_sk",
        ndjson,
        "unobserved",
      )
    ).isOk(),
  ).toBe(true);
  expect(
    (
      await client.ingestQueuedBatch("case_law_v5_cs_sk", ndjson, "unobserved")
    ).isOk(),
  ).toBe(true);

  // Both persist their acceptance, so both demand the exact receipt; only
  // when that acceptance becomes visible differs, and that is the commit
  // value. A queued call sent as `wait_for` would silently be the slow path.
  expect(requests.map(({ search }) => search)).toEqual([
    `?commit=${CORPUS_INDEX_COMMIT.waitFor}`,
    `?commit=${CORPUS_INDEX_COMMIT.auto}`,
  ]);
});

test("queued ingest rejects a partial V2 receipt", async () => {
  responseBody = {
    num_docs_for_processing: 2,
    num_ingested_docs: 1,
    num_rejected_docs: 0,
  };

  const result = await getCorpusIndexClient("q09").ingestQueuedBatch(
    "case_law_v5_cs_sk",
    '{"document_id":"a"}\n{"document_id":"b"}',
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.rejection).toBe("unknown");
  }
});

test("an ingest receipt with zero ingested and rejected documents is definite", async () => {
  responseBody = {
    num_docs_for_processing: 2,
    num_ingested_docs: 0,
    num_rejected_docs: 2,
  };

  const result = await getCorpusIndexClient("q09").ingestCommittedBatch(
    "case_law_v5_cs_sk",
    '{"document_id":"a"}\n{"document_id":"b"}',
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.rejection).toBe("definite");
  }
});

test("final-generation ingest rejects missing or partial V2 counters", async () => {
  for (const receipt of [
    { num_docs_for_processing: 2, num_rejected_docs: 0 },
    {
      num_docs_for_processing: 2,
      num_ingested_docs: 1,
      num_rejected_docs: 0,
    },
    {
      num_docs_for_processing: 2,
      num_ingested_docs: 2,
      num_rejected_docs: 1,
    },
  ]) {
    responseBody = receipt;
    const result = await getCorpusIndexClient("q09").ingestCommittedBatch(
      "case_law_v5_cs_sk",
      '{"document_id":"a"}\n{"document_id":"b"}',
      "unobserved",
    );
    expect(result.isErr()).toBe(true);
  }
});

// Bun rejects a request whose timeout fires with the abort reason alone —
// a DOMException reading "The operation timed out." and nothing else. On
// the backfill path that reaches the log as the whole story, so the client
// has to say which request expired and how long it had.
const rejectFetchWith = (reason: unknown): void => {
  const stub = async (): Promise<Response> => {
    throw reason;
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
};

test("ingest names the request and its budget when the transport fails", async () => {
  rejectFetchWith(new DOMException("The operation timed out.", "TimeoutError"));

  const result = await getCorpusIndexClient("q09").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}',
    CORPUS_INDEX_COMMIT.waitFor,
    "unobserved",
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe(
      `corpus index POST /api/v1/legal_corpus_v1_cze/ingest?commit=${CORPUS_INDEX_COMMIT.waitFor} failed within its ${CORPUS_INDEX_INGEST_TIMEOUT_MS}ms budget: TimeoutError: The operation timed out.`,
    );
  }
});

test("each request reports its own budget, not a shared one", async () => {
  rejectFetchWith(new DOMException("The operation timed out.", "TimeoutError"));

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    // The search budget differs from the ingest budget above, so a message
    // that hardcoded one of them could not satisfy both tests.
    expect(result.error.message).toBe(
      "corpus index POST /api/v1/legal_corpus_v1_cze/search failed within its 30000ms budget: TimeoutError: The operation timed out.",
    );
  }
});

test("an unreadable success body names the request too", async () => {
  const stub = async (): Promise<Response> =>
    new Response("not json", { status: 200 });
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(
      "corpus index POST /api/v1/legal_corpus_v1_cze/search returned an unreadable body:",
    );
  }
});

test("a body that stalls past the budget is a timeout, not an unreadable body", async () => {
  // The timeout covers the body as well as the headers, so a response can
  // arrive `ok` and then abort mid-stream. Reporting that as a malformed
  // payload would hide the very timeout this client exists to name.
  const stub = async (): Promise<Response> =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(
            new DOMException("The operation timed out.", "TimeoutError"),
          );
        },
      }),
      { status: 200 },
    );
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe(
      "corpus index POST /api/v1/legal_corpus_v1_cze/search failed within its 30000ms budget: TimeoutError: The operation timed out.",
    );
  }
});

test("a request that never reaches the engine is not reported as a timeout", async () => {
  rejectFetchWith(
    new Error("Unable to connect. Is the computer able to access the url?"),
  );

  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    // No budget expired here, so quoting one would misdescribe the failure.
    expect(result.error.message).toBe(
      "corpus index POST /api/v1/legal_corpus_v1_cze/search could not be sent: Error: Unable to connect. Is the computer able to access the url?",
    );
  }
});

test("a scored search projects named stored fields and sorts by score", () => {
  expect(
    corpusIndexScoredSearchRequest({
      observer: "unobserved",
      indexId: "case_law_v5_cs_sk",
      query: 'text:"a" AND jurisdiction:"SVK"',
      from: 2000,
      size: 1000,
      fields: ["document_id", "chunk_id"],
      requiredFields: ["document_id"],
    }),
  ).toEqual({
    path: "/api/v1/_elastic/case_law_v5_cs_sk/_search?_source_includes=document_id,chunk_id",
    body: {
      query: {
        query_string: {
          query: 'text:"a" AND jurisdiction:"SVK"',
          default_operator: "AND",
        },
      },
      from: 2000,
      size: 1000,
      sort: [{ _score: { order: "desc" } }],
      track_total_hits: true,
    },
  });
});

test.each([
  [[], []],
  [["document_id", "text&x=1"], []],
  [["a,b"], []],
  // A field every hit must carry has to be one the request projects.
  [["chunk_id"], ["document_id"]],
])(
  "a scored search refuses the field list %p requiring %p",
  (fields, requiredFields) => {
    expect(() =>
      corpusIndexScoredSearchRequest({
        observer: "unobserved",
        indexId: "case_law_v5_cs_sk",
        query: "text:a",
        from: 0,
        size: 10,
        fields,
        requiredFields,
      }),
    ).toThrow(/scored (corpus )?search/u);
  },
);

test("a scored response reads the score from the sort value", () => {
  expect(
    parseCorpusIndexScoredSearchResponse(
      {
        hits: {
          total: { value: 12, relation: "eq" },
          hits: [
            { _source: { document_id: "a", chunk_id: "a:0" }, sort: [9.5] },
            { _source: { document_id: "b" }, _score: 7.25 },
          ],
        },
      },
      ["document_id"],
    ),
  ).toEqual({
    numHits: 12,
    hits: [
      { fields: { document_id: "a", chunk_id: "a:0" }, score: 9.5 },
      // A passage field is optional: a document-granular index has none.
      { fields: { document_id: "b" }, score: 7.25 },
    ],
  });
});

test.each([
  null,
  { hits: [] },
  { hits: { total: 3, hits: [] } },
  { hits: { total: { value: -1 }, hits: [] } },
  // No score.
  { hits: { total: { value: 1 }, hits: [{ _source: { document_id: "a" } }] } },
  // A `_source` that is not a document.
  {
    hits: {
      total: { value: 1 },
      hits: [{ _source: "document", sort: [1] }],
    },
  },
  // A `_source` that is missing or null reads as nothing, not as a hit.
  { hits: { total: { value: 1 }, hits: [{ sort: [1] }] } },
  { hits: { total: { value: 1 }, hits: [{ _source: null, sort: [1] }] } },
  // The field the reader identifies a hit by is missing or null.
  {
    hits: {
      total: { value: 1 },
      hits: [{ _source: { chunk_id: "a:0" }, sort: [1] }],
    },
  },
  {
    hits: {
      total: { value: 1 },
      hits: [{ _source: { document_id: null }, sort: [1] }],
    },
  },
])("a scored response of another shape is refused", (response) => {
  expect(
    parseCorpusIndexScoredSearchResponse(response, ["document_id"]),
  ).toBeNull();
});

test("corpus outbound attempts carry distinct call identities inside the admitted action", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  const rows: ActionCostObservation[] = [];
  await runObservedAction({
    identity: {
      organizationId: toSafeId<"organization">("fixture-org"),
      actionKind: "mcp.services/call",
      logicalPhaseId: "fixture-phase",
    },
    userId: null,
    recorder: {
      enqueue: (row) => {
        rows.push(row);
      },
      estimate: () => null,
      callRate: () => 7,
    },
    run: async () => {
      const observer = actionRequestObserver(
        toSafeId<"organization">("fixture-org"),
        ACTION_COST_CALL_KIND.corpusRequest,
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await getCorpusIndexClient("q09").search({
          observer,
          indexId: "fixture-index",
          query: "fixture",
          maxHits: 3,
        });
        expect(outcome.isOk()).toBe(true);
      }
    },
  });
  const calls = rows.filter((row) => row.type === "call");
  expect(requests).toHaveLength(2);
  expect(calls).toHaveLength(requests.length);
  expect(calls.at(0)?.record).toMatchObject({
    kind: ACTION_COST_CALL_KIND.corpusRequest,
    measuredMicroUnits: 7,
    logicalPhaseId: "fixture-phase",
  });
  expect(calls.at(0)?.record.callId).not.toBe(calls.at(1)?.record.callId);
});

test("cached corpus clients honor each request observer and observe every settlement pass", async () => {
  responseBody = {
    splits: [publishedSplit({ id: "fixture-split", deleteOpstamp: 42 })],
  };
  const client = getCorpusIndexClient("q09");
  const calls = { first: 0, second: 0 };
  const failures: unknown[] = [];
  for (const owner of ["first", "second"] as const) {
    const before = requests.length;
    const result = await client.readDeleteSettlements({
      indexId: "fixture-index",
      tasks: [{ requiredOpstamp: 42, deleteCreatedAt: null }],
      observer: {
        onRequest: () => {
          calls[owner] += 1;
        },
        onError: (cause) => {
          failures.push(cause);
        },
      },
    });
    expect(result.isOk()).toBe(true);
    expect(calls[owner]).toBe(requests.length - before);
    expect(calls[owner]).toBeGreaterThan(1);
  }
  expect(calls.first + calls.second).toBe(requests.length);
  expect(failures).toEqual([]);
});

test("a failed corpus observer reports the failure and still sends the request", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  const cause = new Error("fixture observer failure");
  const failures: unknown[] = [];
  const result = await getCorpusIndexClient("q09").search({
    indexId: "fixture-index",
    query: "fixture",
    maxHits: 3,
    observer: {
      onRequest: () => {
        throw cause;
      },
      onError: (failure) => {
        failures.push(failure);
      },
    },
  });
  expect(result.isOk()).toBe(true);
  expect(requests).toHaveLength(1);
  expect(failures).toEqual([cause]);
});

test("a caller retry records every corpus outbound attempt into its captured action", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  const rows: ActionCostObservation[] = [];
  const organizationId = toSafeId<"organization">("fixture-org");
  await runObservedAction({
    identity: {
      organizationId,
      actionKind: "mcp.services/call",
      logicalPhaseId: "fixture-retry-phase",
    },
    userId: null,
    recorder: {
      enqueue: (row) => {
        rows.push(row);
      },
      estimate: () => null,
      callRate: () => 7,
    },
    run: async () => {
      const observer = actionRequestObserver(
        organizationId,
        ACTION_COST_CALL_KIND.corpusRequest,
      );
      const input = {
        indexId: "fixture-index",
        query: "fixture",
        maxHits: 3,
        observer,
      };
      responseStatus = 429;
      const failed = await getCorpusIndexClient("q09").search(input);
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) {
        expect(failed.error.rejection).toBe("transient");
      }
      responseStatus = 200;
      const retried = await getCorpusIndexClient("q09").search(input);
      expect(retried.isOk()).toBe(true);
    },
  });
  const calls = rows.filter((row) => row.type === "call");
  expect(requests).toHaveLength(2);
  expect(calls).toHaveLength(requests.length);
  for (const call of calls) {
    expect(call.record).toMatchObject({
      organizationId,
      kind: ACTION_COST_CALL_KIND.corpusRequest,
      logicalPhaseId: "fixture-retry-phase",
    });
  }
  expect(calls.at(0)?.record.callId).not.toBe(calls.at(1)?.record.callId);
});
