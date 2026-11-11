import { describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { SEARCH_PAGINATION_COMPLETE } from "@stll/api-contract/search";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  searchCaseLawSectionBodySchema,
  searchCaseLawSectionHandler,
} from "@/api/handlers/search/case-law";
import { HttpStatusResponse, status } from "@/api/http/status";
import { toSafeId } from "@/api/lib/branded-types";
import type { loadPracticeJurisdictions } from "@/api/lib/db/practice-jurisdictions";
import type { CaseLawCountrySearch } from "@/api/lib/legal-search/case-law-multi-country";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * `POST /v1/search/case-law`: the palette's case-law section, answered by the
 * corpus search engine per country, in the global-search hit shape.
 */

const ORGANIZATION_ID = toSafeId<"organization">("org_1");
const DECISION_ID = "00000000-0000-4000-8000-0000000d0001";
const scopedDb = asTestRaw<ScopedDb>({});

type SearchCall = {
  body: { country: string; limit: number; cursor?: string };
  signal?: AbortSignal;
};

const corpusHit = (country: string) => ({
  decisionId: DECISION_ID,
  caseNumber: "25 Cdo 1234/2024",
  caseNumberType: "case_number",
  slug: "25-cdo-1234-2024",
  ecli: null,
  identifiers: [],
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  courtTier: "supreme",
  country,
  language: "cs",
  languageAlternates: [
    {
      caseNumber: "25 Cdo 1234/2024",
      country,
      court: "Nejvyšší soud",
      decisionDate: "2024-05-01",
      id: "00000000-0000-4000-8000-0000000d0002",
      language: "en",
      slug: "25-cdo-1234-2024",
    },
  ],
  decisionDate: "2024-05-01",
  headline: "odpovědnost za <mark>škodu</mark>",
  createdAt: "2024-05-02T00:00:00.000Z",
});

const corpus = (
  answer: (call: SearchCall) => unknown = ({ body }) => ({
    hits: [corpusHit(body.country)],
    nextCursor: `${body.country}:${body.cursor ?? "0"}+1`,
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  }),
) => {
  const calls: SearchCall[] = [];
  const search = mock(async (call: SearchCall) => {
    calls.push(call);
    return await Promise.resolve(answer(call));
  });
  return { calls, search: asTestRaw<CaseLawCountrySearch>(search) };
};

const practising = (
  jurisdictions: readonly { countryCode: string; isPrimary: boolean }[],
) =>
  asTestRaw<typeof loadPracticeJurisdictions>(
    async () => await Promise.resolve(jurisdictions),
  );

const body = (overrides: Record<string, unknown> = {}) =>
  v.parse(searchCaseLawSectionBodySchema, {
    query: "odpovědnost za škodu",
    ...overrides,
  });

describe("the palette's case-law section", () => {
  test("asks only the countries the organization practises in", async () => {
    expect(PUBLIC_CASE_LAW_COUNTRIES).toContain("CZE");
    const { calls, search } = corpus();
    await searchCaseLawSectionHandler({
      body: body(),
      organizationId: ORGANIZATION_ID,
      scopedDb,
      search,
      loadJurisdictions: practising([{ countryCode: "CZ", isPrimary: true }]),
    });

    expect(calls.map(({ body: { country } }) => country)).toEqual(["CZE"]);
    expect(calls.at(0)?.body.limit).toBe(
      LIMITS.searchCaseLawSectionPageSizeDefault,
    );
  });

  test("asks every admitted country when the organization records none", async () => {
    const { calls, search } = corpus();
    await searchCaseLawSectionHandler({
      body: body(),
      organizationId: ORGANIZATION_ID,
      scopedDb,
      search,
      loadJurisdictions: practising([]),
    });

    expect(calls.map(({ body: { country } }) => country).toSorted()).toEqual(
      [...PUBLIC_CASE_LAW_COUNTRIES].toSorted(),
    );
    // The page is split across them, never more than asked for in total.
    expect(calls.reduce((total, { body: { limit } }) => total + limit, 0)).toBe(
      Math.max(
        LIMITS.searchCaseLawSectionPageSizeDefault,
        PUBLIC_CASE_LAW_COUNTRIES.length,
      ),
    );
  });

  test("answers corpus hits in the global-search hit shape", async () => {
    const { search } = corpus();
    const answer = await searchCaseLawSectionHandler({
      body: body(),
      organizationId: ORGANIZATION_ID,
      scopedDb,
      search,
      loadJurisdictions: practising([{ countryCode: "CZ", isPrimary: true }]),
    });

    expect(answer).toMatchObject({
      hits: [
        {
          id: `case-law:${DECISION_ID}`,
          type: "case-law",
          decisionId: DECISION_ID,
          caseNumber: "25 Cdo 1234/2024",
          court: "Nejvyšší soud",
          courtAbbreviation: "NS",
          country: "CZE",
          decisionDate: "2024-05-01",
          slug: "25-cdo-1234-2024",
          language: "cs",
          // Only whether to name the language travels with a hit.
          languageAlternates: [{ language: "en" }],
          title: "25 Cdo 1234/2024 - Nejvyšší soud",
          headline: "odpovědnost za <mark>škodu</mark>",
          resource: { type: "case_law_decision", id: DECISION_ID },
        },
      ],
    });
  });

  test("its cursor resumes each country where it stopped", async () => {
    const { calls, search } = corpus();
    const options = {
      organizationId: ORGANIZATION_ID,
      scopedDb,
      search,
      loadJurisdictions: practising([
        { countryCode: "CZ", isPrimary: true },
        { countryCode: "SK", isPrimary: false },
      ]),
    };
    const first = await searchCaseLawSectionHandler({
      ...options,
      body: body(),
    });
    const nextCursor =
      "nextCursor" in first && typeof first.nextCursor === "string"
        ? first.nextCursor
        : undefined;
    expect(nextCursor).toBeDefined();

    calls.length = 0;
    await searchCaseLawSectionHandler({
      ...options,
      body: body({ cursor: nextCursor }),
    });
    expect(
      Object.fromEntries(
        calls.map(({ body: { country, cursor } }) => [country, cursor]),
      ),
    ).toEqual({ CZE: "CZE:0+1", SVK: "SVK:0+1" });
  });

  test("ends when every country's pages ended", async () => {
    const { search } = corpus(({ body: { country } }) => ({
      hits: [corpusHit(country)],
      nextCursor: null,
      paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    }));
    const answer = await searchCaseLawSectionHandler({
      body: body(),
      organizationId: ORGANIZATION_ID,
      scopedDb,
      search,
      loadJurisdictions: practising([{ countryCode: "CZ", isPrimary: true }]),
    });

    expect(answer).toMatchObject({ nextCursor: null });
  });

  test("a country's refusal is the answer, not an empty section", async () => {
    const refusal = status(503, { message: "Search index unavailable" });
    const { search } = corpus(() => refusal);
    const answer = await searchCaseLawSectionHandler({
      body: body(),
      organizationId: ORGANIZATION_ID,
      scopedDb,
      search,
      loadJurisdictions: practising([{ countryCode: "CZ", isPrimary: true }]),
    });

    expect(answer).toBe(refusal);
  });

  test("refuses a cursor it did not mint", async () => {
    const { calls, search } = corpus();
    const answer = await searchCaseLawSectionHandler({
      body: body({ cursor: "not-a-cursor" }),
      organizationId: ORGANIZATION_ID,
      scopedDb,
      search,
      loadJurisdictions: practising([]),
    });

    expect(answer).toBeInstanceOf(HttpStatusResponse);
    expect(answer).toMatchObject({ code: 400 });
    expect(calls).toEqual([]);
  });

  test("the request body bounds the page and needs a query", () => {
    expect(
      v.safeParse(searchCaseLawSectionBodySchema, { query: "  " }).success,
    ).toBe(false);
    expect(
      v.safeParse(searchCaseLawSectionBodySchema, {
        query: "škoda",
        limit: LIMITS.searchCaseLawSectionPageSizeMax + 1,
      }).success,
    ).toBe(false);
  });
});
