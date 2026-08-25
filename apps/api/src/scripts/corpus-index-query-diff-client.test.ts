import { afterEach, beforeEach, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { corpusIndexQueryDiffClientForGeneration } from "@/api/scripts/corpus-index-query-diff-client";

type RecordedRequest = { host: string };

const originalFetch = globalThis.fetch;
const originalEndpoints = {
  CORPUS_INDEX_ENDPOINT: envBase.CORPUS_INDEX_ENDPOINT,
  CORPUS_INDEX_SEARCH_ENDPOINT: envBase.CORPUS_INDEX_SEARCH_ENDPOINT,
  CORPUS_INDEX_Q09_ENDPOINT: envBase.CORPUS_INDEX_Q09_ENDPOINT,
  CORPUS_INDEX_Q09_SEARCH_ENDPOINT: envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT,
};

let requests: RecordedRequest[];

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

beforeEach(() => {
  requests = [];
  const stub = async (
    input: Parameters<typeof fetch>[0],
  ): Promise<Response> => {
    const url = new URL(requestUrl(input));
    requests.push({ host: url.host });
    return new Response(
      JSON.stringify({ num_hits: 0, hits: [], snippets: [] }),
      { status: 200 },
    );
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
  Object.assign(envBase, {
    CORPUS_INDEX_ENDPOINT: "http://localhost:7281",
    CORPUS_INDEX_SEARCH_ENDPOINT: "http://localhost:7282",
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "http://localhost:7292",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(envBase, originalEndpoints);
});

test("v4 and v5 query clients use their distinct cluster endpoints", async () => {
  const base = await corpusIndexQueryDiffClientForGeneration(
    "case_law_v4",
  ).search({
    indexId: "case_law_v4_cze",
    query: "text:smlouva",
    maxHits: 1,
  });
  const candidate = await corpusIndexQueryDiffClientForGeneration(
    "case_law_v5",
  ).search({
    indexId: "case_law_v5_cs_sk",
    query: "text:smlouva",
    maxHits: 1,
  });

  expect(base.isOk()).toBe(true);
  expect(candidate.isOk()).toBe(true);
  expect(requests.map(({ host }) => host)).toEqual([
    "localhost:7282",
    "localhost:7292",
  ]);
  expect(requests.at(0)?.host).not.toBe(requests.at(1)?.host);
});
