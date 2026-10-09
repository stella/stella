import { toSafeId } from "@stll/api-contract/safe-id";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import {
  currentStatuteViewerFixture,
  historicalStatuteViewerFixture,
} from "@stll/legal-ast/fixtures/statute-viewer";

const absentText = {
  reason: "not_published",
  type: "absent",
} as const;
const decision = {
  caseNumber: "SYN 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationsFrom: [],
  citationsNextCursor: null,
  citationsTo: [],
  country: "CZE",
  court: "Synthetic court",
  courtAbbreviation: null,
  courtTier: "other" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  decisionDate: "2026-01-01",
  decisionType: "Judgment",
  documentAst: null,
  documentAstSource: null,
  projectionDigest: null,
  hasDocument: true,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  documentUrl: null,
  ecli: null,
  fulltext:
    "Synthetic decision text for docked composer geometry.\n\nThe court considered the contract and resolved the claim.",
  headnote: absentText,
  id: toSafeId<"caseLawDecision">("019a0000-0000-7000-8000-000000000101"),
  identifiers: [
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "SYN 1/2026" },
  ],
  judges: [],
  language: "cs",
  languageAlternates: [],
  languageGroupKey: null,
  metadata: {},
  resolution: { type: "direct" as const },
  sections: null,
  slug: "synthetic-dock-decision",
  source: {
    adapterKey: "synthetic",
    allowsDerivedAi: true,
    id: toSafeId<"caseLawSource">("019a0000-0000-7000-8000-000000000102"),
    name: "Synthetic fixture source",
  },
  sourceAttributionUrl: null,
  sourceUrl: null,
  textFields: {
    abstract: absentText,
    headnote: absentText,
    legalSentence: absentText,
    summary: absentText,
  },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const languageAlternates = ["cs", "en"].map((language, index) => ({
  caseNumber: "SYN 2/2026",
  country: decision.country,
  court: decision.court,
  decisionDate: decision.decisionDate,
  hasDocument: true,
  id:
    index === 0
      ? "019a0000-0000-7000-8000-000000000103"
      : "019a0000-0000-7000-8000-000000000104",
  language,
  slug: "synthetic-dock-bilingual-decision",
}));
const bilingualDecision = {
  ...decision,
  caseNumber: "SYN 2/2026",
  id: toSafeId<"caseLawDecision">("019a0000-0000-7000-8000-000000000104"),
  identifiers: [
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "SYN 2/2026" },
  ],
  language: "en",
  languageAlternates,
  languageGroupKey: "synthetic-dock-bilingual",
  slug: "synthetic-dock-bilingual-decision",
};
const bilingualCzechDecision = {
  ...bilingualDecision,
  id: toSafeId<"caseLawDecision">("019a0000-0000-7000-8000-000000000103"),
  language: "cs",
};

const statute = {
  ...currentStatuteViewerFixture,
  id: toSafeId<"legislationDocument">("019a0000-0000-7000-8000-000000000105"),
};
const olderStatute = {
  ...historicalStatuteViewerFixture,
  id: toSafeId<"legislationDocument">("019a0000-0000-7000-8000-000000000107"),
};

const noProvisions = {
  status: { type: "current" as const },
  generation: "synthetic-dock",
  publishedProjectionDigest: null,
  nextCursor: null,
  limit: 100,
  items: [],
  previews: [],
};
const noCitations = {
  nextCursor: null,
  limit: 50,
  items: [],
};
const noLeadingCitations = {
  items: [],
};
const treatmentCounts = {
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  mixed: 0,
  unclassified: 0,
};
const citationSummary = {
  incoming: treatmentCounts,
  outgoing: treatmentCounts,
  precision: { status: "exact" as const },
  incomingByYear: [],
};
const {
  citationCaseCount: _citationCaseCount,
  documentAst: _documentAst,
  fulltext: _fulltext,
  sections: _sections,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...version
} = statute;
const versions = {
  items: [
    { ...version, isDefault: true },
    {
      ...version,
      id: olderStatute.id,
      status: olderStatute.status,
      effectiveDate: olderStatute.effectiveDate,
      versionValidFrom: olderStatute.versionValidFrom,
      versionValidTo: olderStatute.versionValidTo,
      isDefault: false,
    },
  ],
  nextCursor: null,
  limit: 200,
};

export const dockedChatLegalPayloads = {
  decision,
  bilingualDecision,
  bilingualCzechDecision,
  statute,
  olderStatute,
  noProvisions,
  noCitations,
  noLeadingCitations,
  citationSummary,
  versions,
};
