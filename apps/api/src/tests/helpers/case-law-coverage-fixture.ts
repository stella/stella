import type { readCaseLawCoverageHandler } from "@/api/handlers/case-law/decisions/coverage";

const asOf = "2026-10-01T12:00:00.000Z";
const storedAsOf = "2026-09-30T12:00:00.000Z";
const base = {
  health: "current",
  stored: { decisions: 150, asOf: storedAsOf },
  addedLastWeek: 5,
  completeness: {
    measuredSources: 1,
    stored: 150,
    reported: 200,
    storedAsOf,
    staleSources: 0,
    notMeasuredSources: 0,
    notCountedSources: 0,
  },
  sources: [
    {
      adapterKey: "synthetic-source",
      name: "Synthetic publisher",
      publicHomeUrl:
        "https://example.test/00000000-0000-4000-8000-000000000002",
      health: "current",
      lastSyncAt: storedAsOf,
      decisionYearFrom: 1993,
      decisionYearTo: 2026,
      pendingTextCount: 3,
      storedDecisions: 150,
      knownGaps: {
        type: "not_reconciled",
        reason: "The source listing is not date-sliced.",
      },
      completeness: { state: "not-measured-yet" },
      addedLastWeek: 5,
    },
  ],
} as const;

export const CASE_LAW_COVERAGE_FIXTURE = {
  generatedAt: asOf,
  provisionProcessing: [],
  totals: { searchable: 100, stored: { decisions: 300, asOf: storedAsOf } },
  countries: [
    {
      ...base,
      country: "CZE",
      availability: "searchable",
      searchable: 100,
      decisionYearFrom: 1993,
      decisionYearTo: 2026,
      courts: [
        {
          type: "court",
          court: "Nejvyšší soud",
          courtAbbreviation: "NS",
          tier: "supreme",
          decisions: 60,
          addedLastDay: 1,
          addedLastWeek: 5,
          updatedAt: storedAsOf,
        },
        {
          type: "tier",
          tier: "regional",
          courts: 8,
          decisions: 30,
          addedLastDay: 0,
          addedLastWeek: 0,
          updatedAt: null,
        },
        { type: "other-courts", tier: "other", courts: null, decisions: 10 },
      ],
    },
    { ...base, country: "SVK", availability: "in-preparation" },
    {
      ...base,
      stored: { decisions: 0, asOf: null },
      country: "EU",
      availability: "searchable",
      searchable: 0,
      decisionYearFrom: null,
      decisionYearTo: null,
      courts: null,
    },
  ],
} as const satisfies Awaited<ReturnType<typeof readCaseLawCoverageHandler>>;

const expectedSources = [
  {
    adapterKey: "synthetic-source",
    name: "Synthetic publisher",
    lastSyncAt: storedAsOf,
    decisionYearFrom: 1993,
    decisionYearTo: 2026,
    pendingTextCount: 3,
    knownGaps: {
      type: "not_reconciled",
      reason: "The source listing is not date-sliced.",
    },
  },
] as const;

export const CASE_LAW_COVERAGE_EXPECTED = {
  asOf,
  countries: [
    {
      country: "CZE",
      availability: "searchable",
      decisions: 100,
      decisionYearFrom: 1993,
      decisionYearTo: 2026,
      sources: expectedSources,
      courts: [
        { type: "court", court: "Nejvyšší soud", decisions: 60 },
        { type: "tier", tier: "regional", courts: 8, decisions: 30 },
        { type: "other-courts", courts: null, decisions: 10 },
      ],
    },
    {
      country: "SVK",
      availability: "in-preparation",
      decisions: 150,
      decisionYearFrom: null,
      decisionYearTo: null,
      sources: expectedSources,
      courts: null,
    },
    {
      country: "EU",
      availability: "searchable",
      decisions: 0,
      decisionYearFrom: null,
      decisionYearTo: null,
      sources: expectedSources,
      courts: null,
    },
  ],
};
