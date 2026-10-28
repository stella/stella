import type {
  CaseLawCoverage,
  CaseLawCoverageCountry,
  CaseLawCoverageSource,
} from "./coverage.logic";

/** When the publisher's own total was read. */
const OBSERVED_AT = "2026-09-01T00:00:00.000Z";

/** When the corpus was counted, which is a separate sweep and a separate date. */
const COUNTED_AT = "2026-09-17T00:00:00.000Z";

/**
 * A source four decisions in a thousand short of the publisher's total: the
 * boundary the displayed percentage must never round up through.
 */
export const NEARLY_COMPLETE: CaseLawCoverageSource = {
  adapterKey: "cz-ns",
  name: "Nejvyšší soud",
  publicHomeUrl: "https://rozhodnuti.nsoud.cz/",
  health: "current",
  lastSyncAt: OBSERVED_AT,
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  pendingTextCount: 0,
  storedDecisions: 996,
  publishedDecisions: 990,
  courts: [{ court: "Nejvyšší soud", decisions: 990 }],
  knownGaps: { type: "not_reconciled", reason: "No date slices" },
  addedLastWeek: 12,
  completeness: {
    state: "measured",
    stored: 996,
    storedAsOf: COUNTED_AT,
    reported: 1000,
    reportedAsOf: OBSERVED_AT,
    reportedBy: "publisher",
  },
};

export const NEVER_MEASURED: CaseLawCoverageSource = {
  adapterKey: "cz-us",
  name: "Ústavní soud",
  publicHomeUrl: "https://nalus.usoud.cz/",
  health: "delayed",
  lastSyncAt: OBSERVED_AT,
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  pendingTextCount: 0,
  storedDecisions: 4321,
  publishedDecisions: 4200,
  courts: [{ court: "Ústavní soud", decisions: 4200 }],
  knownGaps: { type: "not_reconciled", reason: "No date slices" },
  addedLastWeek: 0,
  completeness: { state: "not-measured-yet" },
};

/** A publisher total exists; nobody has counted what the corpus holds of it. */
const NEVER_COUNTED: CaseLawCoverageSource = {
  adapterKey: "cz-nss",
  name: "Nejvyšší správní soud",
  publicHomeUrl: "https://vyhledavac.nssoud.cz/",
  health: "current",
  lastSyncAt: OBSERVED_AT,
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  pendingTextCount: 0,
  storedDecisions: null,
  publishedDecisions: 600,
  courts: [{ court: "Nejvyšší správní soud", decisions: 600 }],
  knownGaps: { type: "not_reconciled", reason: "No date slices" },
  addedLastWeek: 0,
  completeness: { state: "not-counted-yet" },
};

export const CZECHIA: CaseLawCoverageCountry = {
  availability: "searchable",
  country: "CZE",
  health: "delayed",
  stored: { decisions: 1996, asOf: COUNTED_AT },
  addedLastWeek: 12,
  searchable: 1900,
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  courts: [
    {
      type: "court",
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
      tier: "supreme",
      decisions: 1900,
      addedLastDay: 2,
      addedLastWeek: 12,
      updatedAt: OBSERVED_AT,
    },
  ],
  completeness: {
    measuredSources: 1,
    stored: 996,
    reported: 1000,
    storedAsOf: COUNTED_AT,
    staleSources: 0,
    notMeasuredSources: 1,
    notCountedSources: 1,
  },
  sources: [NEARLY_COMPLETE, NEVER_MEASURED, NEVER_COUNTED],
};

export const COVERAGE: CaseLawCoverage = {
  provisionProcessing: [],
  generatedAt: "2026-09-19T08:00:00.000Z",
  totals: {
    addedLastWeek: 12,
    searchable: 4_200_000,
    stored: { decisions: 4_500_000, asOf: COUNTED_AT },
  },
  countries: [CZECHIA],
};

/** A country the public search cannot reach yet, with nothing counted. */
export const IN_PREPARATION: CaseLawCoverageCountry = {
  availability: "in-preparation",
  country: "SVK",
  health: "current",
  stored: { decisions: 0, asOf: null },
  addedLastWeek: 0,
  completeness: {
    measuredSources: 0,
    stored: 0,
    reported: 0,
    storedAsOf: null,
    staleSources: 0,
    notMeasuredSources: 1,
    notCountedSources: 0,
  },
  sources: [{ ...NEVER_MEASURED, adapterKey: "sk-us", health: "current" }],
};
