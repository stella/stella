import { afterEach, beforeEach, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { corpusIndexQueryDiffClientForGeneration } from "@/api/scripts/corpus-index-query-diff-client";

type RecordedRequest = { host: string };

const originalFetch = globalThis.fetch;
const originalEndpoints = {
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
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: "http://localhost:7292",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(envBase, originalEndpoints);
});

test("compared generations read through the search endpoint, not the mutation one", async () => {
  const base = await corpusIndexQueryDiffClientForGeneration(
    "case_law_v5",
  ).search({
    indexId: "case_law_v5_cs_sk",
    query: "text:smlouva",
    maxHits: 1,
  });
  const candidate = await corpusIndexQueryDiffClientForGeneration(
    "case_law_v6",
  ).search({
    indexId: "case_law_v6_cs_sk",
    query: "text:smlouva",
    maxHits: 1,
  });

  expect(base.isOk()).toBe(true);
  expect(candidate.isOk()).toBe(true);
  expect(requests.map(({ host }) => host)).toEqual([
    "localhost:7292",
    "localhost:7292",
  ]);
});

test("a generation the contract does not know has no query client", () => {
  // The diff gates a generation flip, so an unroutable generation must stop
  // the run rather than resolve to whichever cluster happens to be configured.
  expect(() => corpusIndexQueryDiffClientForGeneration("case_law_v4")).toThrow(
    "Unknown case_law corpus index generation: case_law_v4",
  );
});
