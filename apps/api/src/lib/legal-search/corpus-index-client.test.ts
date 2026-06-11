import { afterEach, beforeEach, expect, test } from "bun:test";

import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";

// Pins the corpus-index HTTP request contract. The engine defaults search
// hits to document-id order unless `sort_by` is sent, and the rank-based
// lexical scoring in the pagination layer assumes relevance order, so a
// missing or misnamed sort parameter silently degrades search to
// id-order results. These tests stub global fetch and assert on the
// outgoing request, not on engine behaviour.

type RecordedRequest = { path: string; body: string };

let requests: RecordedRequest[];
let responseBody: Record<string, unknown>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  responseBody = {};
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
    requests.push({
      path: new URL(resolveUrl(input)).pathname,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("search sends the documented sort_by parameter", async () => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };

  const result = await getCorpusIndexClient().search({
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
    sortBy: "_score",
  });

  expect(result.isOk()).toBe(true);
  const request = requests.at(0);
  expect(request?.path).toBe("/api/v1/legal_corpus_v1_cze/search");
  const body: Record<string, unknown> = JSON.parse(request?.body ?? "{}");
  expect(body["sort_by"]).toBe("_score");
  // The engine ignores unknown keys, so the old misnamed parameter would
  // silently fall back to document-id order.
  expect(body).not.toHaveProperty("sort_by_field");
});

test("search pagination always requests BM25 relevance order", async () => {
  responseBody = {
    num_hits: 1,
    hits: [{ document_id: "doc-1" }],
    snippets: [{ text: ["snippet"] }],
  };

  await readCorpusIndexSearchPage({
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    limit: 10,
    parsedCursor: null,
    snippetFields: ["text"],
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
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

  const result = await getCorpusIndexClient().ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("accepted 1 of 2");
  }
});

test("ingest fails when the engine reports rejected documents", async () => {
  responseBody = { num_docs_for_processing: 2, num_rejected_docs: 1 };

  const result = await getCorpusIndexClient().ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
  );

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("rejected 1 of 2");
  }
});

test("ingest succeeds when every document is accepted", async () => {
  responseBody = { num_docs_for_processing: 2 };

  const result = await getCorpusIndexClient().ingestBatch(
    "legal_corpus_v1_cze",
    '{"document_id":"a"}\n{"document_id":"b"}',
  );

  expect(result.isOk()).toBe(true);
});
