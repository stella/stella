export const APP_SEARCH_FIXTURE = {
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
          message: "Search notice",
          hint: "Try another query.",
        },
      ],
    },
  ],
  results: [
    {
      appUrl: "https://stll.app/case-law/fixture-decision",
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
      snippet: "Náhrada škody: <b>právní jistota</b>.",
      sourceUrl: "https://example.test/decision",
    },
  ],
  total: { type: "exact" as const, count: 1 },
  nextStep: "Use the returned cursor to continue.",
};

const identity = {
  appUrl: "https://stll.app/case-law/fixture-decision",
  url: "https://stll.app/case-law/fixture-decision",
  caseNumber: "I. ÚS 123/24",
  court: "Ústavní soud",
  courtAbbreviation: "ÚS",
  decisionDate: "2024-04-15",
  decisionId: "fixture-decision",
  ecli: "ECLI:CZ:US:2024:1.US.123.24.1",
  resourceName: "case-law/fixture-decision",
};

export const APP_LOOKUP_FIXTURE = {
  items: [
    { identifier: "I. ÚS 123/24", ...identity, status: "found" as const },
    {
      identifier: "123/24",
      candidates: [identity],
      message: "Choose a court.",
      status: "ambiguous" as const,
    },
    {
      identifier: "124/24",
      hint: "Search case law.",
      message: "No matching decision.",
      status: "not_found" as const,
    },
    {
      identifier: "125/24",
      message: "Lookup unavailable.",
      status: "lookup_failed" as const,
    },
  ],
};

export const APP_UNAVAILABLE_FIXTURE = {
  code: "public_country_unavailable" as const,
  status: "unavailable" as const,
  country: "CZE" as const,
  reason: "pending_public" as const,
  message: "Corpus unavailable.",
  hint: "Choose another country.",
};
