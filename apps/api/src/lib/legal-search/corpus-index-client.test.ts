import { afterEach, beforeEach, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import {
  CORPUS_INDEX_CLUSTER_CONFIG,
  CORPUS_INDEX_COMMIT,
  CORPUS_INDEX_COMMIT_WAIT_TIMEOUT_MS,
  CORPUS_INDEX_INGEST_TIMEOUT_MS,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  corpusIndexConfigFromManifest,
  CORPUS_INDEX_MANIFESTS,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";

// Pins the corpus-index HTTP request contract. The engine defaults search
// hits to document-id order unless `sort_by` is sent, and the rank-based
// lexical scoring in the pagination layer assumes relevance order, so a
// missing or misnamed sort parameter silently degrades search to
// id-order results. These tests stub global fetch and assert on the
// outgoing request, not on engine behaviour.

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
const originalCorpusIndexEndpoint = envBase.CORPUS_INDEX_ENDPOINT;
const originalCorpusIndexSearchEndpoint = envBase.CORPUS_INDEX_SEARCH_ENDPOINT;
const originalQ09Endpoint = envBase.CORPUS_INDEX_Q09_ENDPOINT;
const originalQ09SearchEndpoint = envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT;

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
    CORPUS_INDEX_ENDPOINT: originalCorpusIndexEndpoint,
    CORPUS_INDEX_SEARCH_ENDPOINT: originalCorpusIndexSearchEndpoint,
    CORPUS_INDEX_Q09_ENDPOINT: originalQ09Endpoint,
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: originalQ09SearchEndpoint,
  });
});

test("cluster registry is total and q09 never falls back to q08", async () => {
  expect(CORPUS_INDEX_CLUSTER_CONFIG).toEqual({
    q08: {
      mutationEnv: "CORPUS_INDEX_ENDPOINT",
      searchEnv: "CORPUS_INDEX_SEARCH_ENDPOINT",
    },
    q09: {
      mutationEnv: "CORPUS_INDEX_Q09_ENDPOINT",
      searchEnv: "CORPUS_INDEX_Q09_SEARCH_ENDPOINT",
    },
  });
  Object.assign(envBase, {
    CORPUS_INDEX_ENDPOINT: "http://localhost:7281",
    CORPUS_INDEX_SEARCH_ENDPOINT: "http://localhost:7282",
    CORPUS_INDEX_Q09_ENDPOINT: undefined,
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: undefined,
  });

  const result = await getCorpusIndexClient("q09").search({
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
    CORPUS_INDEX_ENDPOINT: "http://localhost:7281",
    CORPUS_INDEX_SEARCH_ENDPOINT: "http://localhost:7282",
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "http://localhost:7292",
  });

  const result = await getCorpusIndexClient("q09").search({
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

  const result =
    await getCorpusIndexClient("q09").attestIndexConfig(finalCaseLawConfig());

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

  const result = await getCorpusIndexClient("q09").attestIndexConfig(config);

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

  const result = await getCorpusIndexClient("q09").attestIndexConfig(config);

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

  const result = await getCorpusIndexClient("q09").attestIndexConfig(config);

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

  const result = await getCorpusIndexClient("q09").attestIndexConfig(config);

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("field_mappings.length");
  }
});

test("search sends the documented sort_by parameter", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };

  const result = await getCorpusIndexClient("q08").search({
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
    sortBy: "_score",
  });

  expect(result.isOk()).toBe(true);
  const request = requests.at(0);
  expect(request?.host).toBe("localhost:7281");
  expect(request?.path).toBe("/api/v1/legal_corpus_v1_cze/search");
  const body: Record<string, unknown> = JSON.parse(request?.body ?? "{}");
  expect(body["sort_by"]).toBe("_score");
  // The engine ignores unknown keys, so the old misnamed parameter would
  // silently fall back to document-id order.
  expect(body).not.toHaveProperty("sort_by_field");
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

  const result = await getCorpusIndexClient("q08").search({
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

  const result = await getCorpusIndexClient("q08").search({
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
    snippetFields: ["text"],
  });

  expect(result.isErr()).toBe(true);
});

test("search rejects a malformed snippets value", async () => {
  responseBody = { num_hits: 1, hits: [], snippets: "no" };

  const result = await getCorpusIndexClient("q08").search({
    indexId: "legal_corpus_v1_cze",
    query: "seq:0",
    maxHits: 0,
  });

  expect(result.isErr()).toBe(true);
});

test("search falls back to the shared corpus index endpoint", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  Object.assign(envBase, {
    CORPUS_INDEX_ENDPOINT: "http://localhost:7290",
    CORPUS_INDEX_SEARCH_ENDPOINT: undefined,
  });

  const result = await getCorpusIndexClient("q08").search({
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isOk()).toBe(true);
  expect(requests.at(0)?.host).toBe("localhost:7290");
});

test("search reads no snippets when snippet fields were requested and nothing matched", async () => {
  // The engine leaves `snippets` out of a zero-hit response even when
  // snippet fields were requested; that is an empty page, not a malformed one.
  responseBody = { num_hits: 0, hits: [] };

  const result = await getCorpusIndexClient("q08").search({
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

  const result = await getCorpusIndexClient("q08").search({
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

  const result = await getCorpusIndexClient("q08").search({
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

test("search pagination always requests BM25 relevance order", async () => {
  responseBody = {
    num_hits: 1,
    hits: [{ document_id: "doc-1" }],
    snippets: [{ text: ["snippet"] }],
  };

  await readCorpusIndexSearchPage({
    cluster: "q08",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    limit: 10,
    parsedCursor: null,
    snippetFields: ["text"],
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (candidates) => ({
      context: null,
      ranked: candidates.map((candidate) => ({
        id: candidate.id,
        score: candidate.score,
        lexicalScore: candidate.score,
        citationAuthority: 0,
      })),
    }),
  });

  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    const body: Record<string, unknown> = JSON.parse(request.body);
    expect(body["sort_by"]).toBe("_score");
  }
});

test("ingest fails when the engine accepts fewer documents than sent", async () => {
  responseBody = { num_docs_for_processing: 1 };

  const result = await getCorpusIndexClient("q08").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
    CORPUS_INDEX_COMMIT.waitFor,
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("accepted 1 of 2");
  }
});

test("ingest fails when the engine reports rejected documents", async () => {
  responseBody = { num_docs_for_processing: 2, num_rejected_docs: 1 };

  const result = await getCorpusIndexClient("q08").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
    CORPUS_INDEX_COMMIT.waitFor,
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("rejected 1 of 2");
  }
});

test("delete-by-query posts one document-scoped delete task", async () => {
  responseBody = { opstamp: 42 };

  const result = await getCorpusIndexClient("q08").deleteByQuery(
    "legal_corpus_v1_cze",
    'document_id:"dec-1"',
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({ opstamp: 42 });
  }
  // One task per document, whatever the index layout: a passage-split
  // document is removed by the same single query as a whole one, so the
  // indexer never has to know how many documents a row previously emitted.
  expect(requests).toHaveLength(1);
  const request = requests.at(0);
  expect(request?.host).toBe("localhost:7280");
  expect(request?.path).toBe("/api/v1/legal_corpus_v1_cze/delete-tasks");
  const body: Record<string, unknown> = JSON.parse(request?.body ?? "{}");
  expect(body["query"]).toBe('document_id:"dec-1"');
});

test("delete-by-query rejects a response without a usable opstamp", async () => {
  responseBody = {};

  const result = await getCorpusIndexClient("q08").deleteByQuery(
    "legal_corpus_v1_cze",
    'document_id:"dec-1"',
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

test("delete settlement compares every published split with the retained task", async () => {
  responseBody = {
    offset: 0,
    size: 3,
    splits: [
      {
        split_id: "split-42",
        split_state: "Published",
        delete_opstamp: 42,
      },
      {
        split_id: "split-41",
        split_state: "Published",
        delete_opstamp: 41,
      },
      {
        split_id: "split-45",
        split_state: "Published",
        delete_opstamp: 45,
      },
    ],
  };

  const result = await getCorpusIndexClient("q08").readDeleteSettlement(
    "legal_corpus_v1_cze",
    42,
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      requiredOpstamp: 42,
      publishedSplits: 3,
      laggingSplits: 1,
      minAppliedOpstamp: 41,
      settled: false,
    });
  }
  expect(requests.at(0)?.path).toBe(
    "/api/v1/indexes/legal_corpus_v1_cze/splits",
  );
  expect(requests.at(0)?.search).toBe(
    "?offset=0&limit=1000&split_states=Published",
  );
});

test("delete settlement rejects an invalid required opstamp", async () => {
  const result = await getCorpusIndexClient("q08").readDeleteSettlement(
    "legal_corpus_v1_cze",
    -1,
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid opstamp");
  }
});

test("delete settlement rejects a split without a usable delete opstamp", async () => {
  responseBody = {
    splits: [{ split_id: "split-1", split_state: "Published" }],
  };

  const result = await getCorpusIndexClient("q08").readDeleteSettlement(
    "legal_corpus_v1_cze",
    42,
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("invalid response");
  }
});

const settlementResponse = (splitCount: number) => (url: URL) => {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const pageSize = Math.min(1000, Math.max(splitCount - offset, 0));
  return {
    splits: Array.from({ length: pageSize }, (_, index) => ({
      split_id: `split-${offset + index}`,
      split_state: "Published",
      delete_opstamp: 42,
    })),
  };
};

test("delete settlement repeats an offset scan until split identities stabilize", async () => {
  let firstPageReads = 0;
  responseBodyForUrl = (url) => {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    if (offset === 0) {
      firstPageReads += 1;
      return {
        splits: Array.from({ length: 1000 }, (_, index) => ({
          split_id:
            firstPageReads === 1 || index > 0 ? `split-${index}` : "split-new",
          split_state: "Published",
          delete_opstamp: 42,
        })),
      };
    }
    return { splits: [] };
  };

  const result = await getCorpusIndexClient("q08").readDeleteSettlement(
    "legal_corpus_v1_cze",
    42,
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.publishedSplits).toBe(1000);
  }
  expect(firstPageReads).toBe(3);
});

test("delete settlement accepts exactly the published split ceiling", async () => {
  responseBodyForUrl = settlementResponse(10_000);

  const result = await getCorpusIndexClient("q08").readDeleteSettlement(
    "legal_corpus_v1_cze",
    42,
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.publishedSplits).toBe(10_000);
    expect(result.value.settled).toBe(true);
  }
});

test("delete settlement rejects the first split beyond its ceiling", async () => {
  responseBodyForUrl = settlementResponse(10_001);

  const result = await getCorpusIndexClient("q08").readDeleteSettlement(
    "legal_corpus_v1_cze",
    42,
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("exceeds 10000");
  }
});

test("ingest sends the commit mode the caller asked for", async () => {
  responseBody = { num_docs_for_processing: 1 };

  for (const commit of Object.values(CORPUS_INDEX_COMMIT)) {
    await getCorpusIndexClient("q08").ingestBatch(
      "legal_corpus_v1_cze",
      '{"document_id":"a"}',
      commit,
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

test("ingest succeeds when every document is accepted", async () => {
  responseBody = { num_docs_for_processing: 2 };

  const result = await getCorpusIndexClient("q08").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
    CORPUS_INDEX_COMMIT.waitFor,
  );

  expect(result.isOk()).toBe(true);
});

test("final-generation ingest requires the exact committed V2 receipt", async () => {
  responseBody = {
    num_docs_for_processing: 2,
    num_ingested_docs: 2,
    num_rejected_docs: 0,
  };

  const result = await getCorpusIndexClient("q08").ingestCommittedBatch(
    "case_law_v5_cs_sk",
    '{"document_id":"a"}\n{"document_id":"b"}',
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
  const client = getCorpusIndexClient("q08");
  const ndjson = '{"document_id":"a"}\n{"document_id":"b"}';

  expect(
    (await client.ingestCommittedBatch("case_law_v5_cs_sk", ndjson)).isOk(),
  ).toBe(true);
  expect(
    (await client.ingestQueuedBatch("case_law_v5_cs_sk", ndjson)).isOk(),
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

  const result = await getCorpusIndexClient("q08").ingestQueuedBatch(
    "case_law_v5_cs_sk",
    '{"document_id":"a"}\n{"document_id":"b"}',
  );

  expect(result.isErr()).toBe(true);
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
    const result = await getCorpusIndexClient("q08").ingestCommittedBatch(
      "case_law_v5_cs_sk",
      '{"document_id":"a"}\n{"document_id":"b"}',
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

  const result = await getCorpusIndexClient("q08").ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}',
    CORPUS_INDEX_COMMIT.waitFor,
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

  const result = await getCorpusIndexClient("q08").search({
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

  const result = await getCorpusIndexClient("q08").search({
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

  const result = await getCorpusIndexClient("q08").search({
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

  const result = await getCorpusIndexClient("q08").search({
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
