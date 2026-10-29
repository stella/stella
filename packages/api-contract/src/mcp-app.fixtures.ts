import * as v from "valibot";

import type { LegalResolveResponse } from "./legal-resolve";
import { publicCountryUnavailableSchema } from "./public-country-capability";

export const APP_SEARCH_FIXTURE = {
  headnotes: "included" as const,
  facets: {
    court: [
      {
        tierLabel: "constitutional" as const,
        courts: [{ value: "Ústavní soud", label: null, count: 1 }],
      },
    ],
    courtYear: null,
    year: [],
    decisionType: [],
    source: [],
    language: [],
  },
  nextCursor: "next_fixture_cursor",
  searches: [
    {
      query: "náhrada škody",
      queryUsed: "náhrada škody",
      warnings: [
        {
          code: "function_words_optional" as const,
          audience: "agent" as const,
          message: "Search notice",
          hint: "Try another query.",
        },
      ],
    },
  ],
  results: [
    {
      url: "https://stll.app/case-law/fixture-decision",
      caseNumber: "I. ÚS 123/24",
      citationCount: 3,
      citationAuthority: 1.4,
      country: "CZE",
      court: "Ústavní soud",
      courtAbbreviation: "ÚS",
      decisionDate: "2024-04-15",
      decisionId: "fixture-decision",
      resourceName: "case-law/fixture-decision",
      decisionType: "nález",
      ecli: "ECLI:CZ:US:2024:1.US.123.24.1",
      language: "cs",
      matchedQueries: [0],
      matchingPassages: 1,
      textState: null,
      textAvailability: "available" as const,
      match: "all_terms" as const,
      sourceUrl: "https://example.test/decision",
      snippet: "Náhrada škody: <b>právní jistota</b>.",
      keywords: {
        type: "keywords" as const,
        items: ["Náhrada škody", "Příčinná souvislost"],
        omitted: 0,
      },
      headnote: {
        type: "present" as const,
        text: "Právo na náhradu škody vyžaduje posouzení příčinné souvislosti.",
        truncated: false,
      },
    },
  ],
  total: { type: "exact" as const, count: 1 },
  nextStep: "Use the returned cursor to continue.",
};

export const APP_RESOLVE_FIXTURE = {
  status: "resolved" as const,
  document: {
    kind: "decision" as const,
    textState: null,
    decisionId: "00000000-0000-4000-8000-0000000d0041",
    identifier: "ECLI:CZ:US:2024:1.US.123.24.1",
    country: "CZE",
    caseNumber: "I. ÚS 123/24",
    ecli: "ECLI:CZ:US:2024:1.US.123.24.1",
    court: "Ústavní soud",
    decisionDate: "2024-04-15",
    language: "cs",
    languageAlternates: [],
    readerUrl: "https://stll.app/case-law/fixture-decision",
    text: {
      status: "readable",
      blocks: [],
      extent: { type: "complete" },
    },
  },
} satisfies LegalResolveResponse;
export const APP_RESOLVE_STATUS_FIXTURES = [
  APP_RESOLVE_FIXTURE,
  {
    status: "ambiguous" as const,
    candidates: [
      {
        textState: null,
        decisionId: APP_RESOLVE_FIXTURE.document.decisionId,
        identifier: "I. ÚS 123/24",
        label: "Ústavní soud, 2024-04-15",
        readerUrl: APP_RESOLVE_FIXTURE.document.readerUrl,
      },
    ],
  },
  { status: "not_found" as const, reason: "no_exact_identity" as const },
  { status: "incomplete_identifier" as const, missing: ["sheet"] },
  { status: "country_unavailable" as const },
] satisfies LegalResolveResponse[];

export const APP_UNAVAILABLE_FIXTURE = v.parse(publicCountryUnavailableSchema, {
  code: "public_country_unavailable",
  domain: "caseLaw",
  status: "unavailable",
  country: "CZE",
  reason: "pending_public",
  message: "Corpus unavailable.",
  hint: "Choose another country.",
});
