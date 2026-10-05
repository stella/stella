import { expect, test } from "bun:test";
import Elysia from "elysia";

import { PUBLIC_COUNTRY_UNAVAILABLE_STATUS } from "@stll/api-contract/public-country-capability";
import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";

import { createPublicStatuteSearch } from "@/api/handlers/legislation/public-search";
import type { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { isSafePublicHandler } from "@/api/lib/api-handlers";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

const result = {
  items: [],
  nextCursor: null,
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  total: { type: SEARCH_TOTAL_TYPE.NOT_COUNTED },
};

const testSearchRoute = (search: typeof searchLegislationHandler) => {
  const definition = createPublicStatuteSearch(search);
  expect(isSafePublicHandler(definition.handler)).toBe(true);
  return new Elysia().get("/law/statutes/search", definition.handler, {
    query: definition.config.query,
    response: definition.config.response,
  });
};

test("signed-out statute search normalizes country and forwards filters through the public read boundary", async () => {
  const calls: Parameters<typeof searchLegislationHandler>[] = [];
  const app = testSearchRoute(async (...args) => {
    calls.push(args);
    return result;
  });
  const response = await app.handle(
    new Request(
      "http://localhost/law/statutes/search?query=n%C3%A1hrada&country=CZ&documentType=act&status=current&language=cs&dateFrom=2024-01-01&dateTo=2025-01-01&limit=20",
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.at(0)).toEqual({
    query: "náhrada",
    jurisdiction: "CZE",
    documentType: "act",
    status: "current",
    language: "cs",
    dateFrom: "2024-01-01",
    dateTo: "2025-01-01",
    limit: 20,
  });
  expect(calls.at(0)?.at(1)).toBe(legislationPublicReadDb);
  expect(calls.at(0)?.at(2)).toBe("unobserved");
});

test("public page limits are bounded before the shared operation runs", async () => {
  const calls: Parameters<typeof searchLegislationHandler>[] = [];
  const app = testSearchRoute(async (...args) => {
    calls.push(args);
    return result;
  });
  for (const limit of [0, 21, 100]) {
    const response = await app.handle(
      new Request(
        `http://localhost/law/statutes/search?query=text&country=CZE&limit=${String(limit)}`,
      ),
    );
    expect(response.status).toBe(422);
  }
  expect(calls).toHaveLength(0);
  const response = await app.handle(
    new Request("http://localhost/law/statutes/search?query=text&country=CZE"),
  );
  expect(response.status).toBe(200);
  expect(calls.at(0)?.at(0)).toMatchObject({
    limit: 20,
  });
});

test.each(["Freedonia", "SVK"])(
  "unadmitted public country %s never reaches retrieval",
  async (country) => {
    const calls: Parameters<typeof searchLegislationHandler>[] = [];
    const app = testSearchRoute(async (...args) => {
      calls.push(args);
      return result;
    });
    const response = await app.handle(
      new Request(
        `http://localhost/law/statutes/search?query=text&country=${country}`,
      ),
    );
    expect(response.status).toBe(
      country === "SVK" ? PUBLIC_COUNTRY_UNAVAILABLE_STATUS : 400,
    );
    expect(calls).toHaveLength(0);
  },
);

test("public pagination preserves the corpus phase cursor in both directions", async () => {
  const cursor = encodeCorpusSearchCursor({
    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
    target: null,
    sort: "relevance",
    id: "5a3e6f52-1f0b-4f7e-9a44-3f2c1d0e9b8a",
    score: 0.5,
    windowStart: 0,
    phase: {
      type: "relaxed",
      generation: "legislation_v2",
      fingerprint: "a".repeat(64),
      strictWorkTokens: ["AbC_1-"],
    },
  });
  const decoded = decodeCorpusSearchCursor(cursor);
  expect(decoded?.phase?.type).toBe("relaxed");
  const calls: Parameters<typeof searchLegislationHandler>[] = [];
  const app = testSearchRoute(async (...args) => {
    calls.push(args);
    return { ...result, nextCursor: cursor };
  });
  const response = await app.handle(
    new Request(
      `http://localhost/law/statutes/search?query=text&country=CZE&cursor=${encodeURIComponent(cursor)}`,
    ),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toEqual({ ...result, nextCursor: cursor });
  const forwarded = calls.at(0)?.at(0);
  expect(forwarded).toMatchObject({ cursor });
});
