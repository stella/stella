import { Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia from "elysia";

import { PUBLIC_COUNTRY_UNAVAILABLE_STATUS } from "@stll/api-contract/public-country-capability";
import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createPublicStatuteSearch } from "@/api/handlers/legislation/public-search";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { isSafePublicHandler } from "@/api/lib/api-handlers";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

const result = {
  items: [],
  nextCursor: null,
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  total: { type: SEARCH_TOTAL_TYPE.NOT_COUNTED },
};

const timingHit = {
  match: { type: "strict" },
  documentId: "6b1d2f34-58aa-4d1c-9d0f-2c3b4a5e6f70",
  eli: "eli/cz/act/2024/1",
  slug: null,
  title: "Timing fixture",
  country: "CZE",
  language: "cs",
  documentType: "act",
  status: "current",
  effectiveDate: "2024-01-01",
  versionValidFrom: "2024-01-01",
  versionValidTo: null,
  sourceUrl: null,
  headline: null,
  score: 1,
} as const;

const timingCandidateIds = [
  timingHit.documentId,
  "7c2e3f45-69bb-4e2d-8a1b-3c4d5e6f7081",
  "8d3f4056-7acc-4f3e-9b2c-4d5e6f708192",
] as const;

const runTimedSearch = async (
  stageToolName?: string,
  failHydration = false,
) => {
  let clock = 0;
  let databaseReads = 0;
  const records: Parameters<
    NonNullable<Parameters<typeof searchLegislationHandler>[3]>["emitStage"]
  >[0][] = [];
  const dependencies = {
    provider: "corpus-index",
    loadSearchConfigs: async () => [],
    readServingGeneration: async () =>
      Result.ok({
        family: "legislation",
        generation: "legislation_v2",
        cluster: "q09",
      }),
    now: () => clock,
    emitStage: (record) => records.push(record),
    ...(stageToolName === undefined ? {} : { stageToolName }),
    corpusReads: {
      readPage: async (options) => {
        clock += 7;
        const ranked = await options.rankCandidates(
          timingCandidateIds.map((id, index) => ({
            id,
            score: 1 - index / 10,
          })),
          {
            excludedGroups: new Set(),
            selectAppliedCandidates: () => {
              clock += 13;
              return timingCandidateIds.map((id, index) => ({
                id,
                score: 1 - index / 10,
              }));
            },
          },
        );
        return {
          pageRanked: [...ranked.ranked],
          context: ranked.context,
          snippetById: new Map(),
          anchorIdById: new Map(),
          passageCountById: new Map(),
          revisionById: ranked.revisionById,
          passageClauseById: new Map(),
          stop: { type: "exhausted" },
          scan: {
            rounds: 1,
            passagesScanned: 1,
            indexMs: 7,
            earlyStopped: false,
            roundCapHit: false,
            highlightRounds: 0,
          },
          lexicalScores: null,
          nextCursor: null,
          paginationOutcome: SEARCH_PAGINATION_COMPLETE,
          reach: "reached",
        };
      },
      readCandidateRows: async (_tx, { ids }) => ({
        rows: ids.map((id) => ({
          id,
          sourceId: "b1a2d3e4-5678-4789-a123-456789abcdef",
          eli: timingHit.eli,
          slug: timingHit.slug,
          title: timingHit.title,
          country: timingHit.country,
          language: timingHit.language,
          documentType: timingHit.documentType,
          statusValue: timingHit.status,
          effectiveDate: timingHit.effectiveDate,
          versionValidFrom: timingHit.versionValidFrom,
          versionValidTo: timingHit.versionValidTo,
          sourceUrl: timingHit.sourceUrl,
          citationAuthority: 0,
          canRecur: false,
          appliedRevision: null,
        })),
        dispositions: [],
      }),
      readNamedWorks: async () => [],
    },
    projectHit: (hit) => {
      clock += 17;
      return hit;
    },
  } satisfies NonNullable<Parameters<typeof searchLegislationHandler>[3]>;
  const db: LegislationReadDb = async (read) => {
    databaseReads += 1;
    if (databaseReads <= 2) {
      return await read(Object.create(null));
    }
    clock += 11;
    if (failHydration) {
      throw new Error("hydration failed");
    }
    return await read({
      execute: async () => [],
      select: () => {
        throw new Error("Unexpected database select");
      },
    });
  };
  const operation = searchLegislationHandler(
    { query: "timing", limit: 1 },
    db,
    "unobserved",
    dependencies,
  );
  return { operation, records };
};

test.each([
  [undefined, false],
  ["search_legislation", true],
] as const)(
  "shared search reports real stage durations for %s entry point",
  async (toolName, hasToolName) => {
    const { operation, records } = await runTimedSearch(toolName);
    await operation;
    expect(records).toEqual([
      expect.objectContaining({
        stage: "index_scan",
        durationMs: 7,
        candidateCount: 3,
      }),
      expect.objectContaining({
        stage: "candidate_hydration",
        durationMs: 11,
        candidateCount: 3,
      }),
      expect.objectContaining({
        stage: "work_collapse_ranking",
        durationMs: 13,
        resultCount: 1,
      }),
      expect.objectContaining({
        stage: "response_serialization",
        durationMs: 17,
        resultCount: 1,
      }),
    ]);
    for (const record of records) {
      expect(record.toolName).toBe(hasToolName ? toolName : undefined);
    }
  },
);

test("a failed hydration reports only the completed index scan", async () => {
  const { operation, records } = await runTimedSearch(undefined, true);
  expect(await rejectionOf(operation)).toEqual(
    expect.objectContaining({ message: "hydration failed" }),
  );
  expect(records.map(({ stage }) => stage)).toEqual(["index_scan"]);
});

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
      "http://localhost/law/statutes/search?query=n%C3%A1hrada&country=CZ&documentType=act&status=current&language=cs&dateFrom=2024-01-01&dateTo=2025-01-01&asOf=2027-01-01&limit=20",
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
    asOf: "2027-01-01",
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
