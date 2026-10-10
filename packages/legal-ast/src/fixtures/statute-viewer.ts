// Synthetic wording shared by the legal viewer and local corpus seed.
export const currentStatuteViewerFixture = {
  expressionKind: "consolidation" as const,
  windowDisposition: "effective" as const,
  windowDispositionBasis: null,
  allowsDerivedAi: true,
  citationCaseCount: null,
  country: "CZE",
  createdAt: "2026-01-01T00:00:00.000Z",
  documentAst: null,
  documentType: "act" as const,
  documentUrl: null,
  effectiveDate: "2024-01-01",
  eli: "/eli/cz/sb/2024/999",
  fulltext:
    "Synthetic statute text for docked composer geometry.\n\nSection 1. This fixture governs the sample contract.",
  language: "cs",
  sections: null,
  slug: "999-2024-sb-synthetic-dock-statute",
  sourceUrl: null,
  status: "current" as const,
  title: "999/2024 Sb., Synthetic dock statute",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versionValidFrom: "2024-01-01",
  versionValidTo: null,
};
export const historicalStatuteViewerFixture = {
  ...currentStatuteViewerFixture,
  effectiveDate: "2020-01-01",
  status: "historical" as const,
  versionValidFrom: "2020-01-01",
  versionValidTo: "2023-12-31",
};
