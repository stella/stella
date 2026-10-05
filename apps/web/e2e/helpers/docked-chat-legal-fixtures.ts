import type { Page } from "@playwright/test";
import { panic } from "better-result";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import {
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { PublicCaseLawDecision } from "../../src/features/case-law/public-decision";
import type { PublicStatute } from "../../src/features/statutes/queries/statutes";
import type { WebApiRoutes } from "../../src/lib/eden-client";
import { toSafeId } from "../../src/lib/safe-id";
import { E2E_API_ORIGIN } from "./api";

const absentText = { reason: "not_published", type: "absent" } as const;
const decision = {
  caseNumber: "SYN 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationsFrom: [],
  citationsNextCursor: null,
  citationsTo: [],
  country: "CZE",
  court: "Synthetic court",
  courtAbbreviation: null,
  courtTier: "other",
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
  resolution: { type: "direct" },
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
} satisfies PublicCaseLawDecision;

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
})) satisfies PublicCaseLawDecision["languageAlternates"];
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
} satisfies PublicCaseLawDecision;
const bilingualCzechDecision = {
  ...bilingualDecision,
  id: toSafeId<"caseLawDecision">("019a0000-0000-7000-8000-000000000103"),
  language: "cs",
} satisfies PublicCaseLawDecision;

const statute = {
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
  allowsDerivedAi: true,
  citationCaseCount: null,
  country: "CZE",
  createdAt: "2026-01-01T00:00:00.000Z",
  documentAst: null,
  documentType: "act",
  documentUrl: null,
  effectiveDate: "2024-01-01",
  eli: "/eli/cz/sb/2024/999",
  fulltext:
    "Synthetic statute text for docked composer geometry.\n\nSection 1. This fixture governs the sample contract.",
  id: toSafeId<"legislationDocument">("019a0000-0000-7000-8000-000000000105"),
  language: "cs",
  sections: null,
  slug: "999-2024-sb-synthetic-dock-statute",
  sourceUrl: null,
  status: "current",
  title: "999/2024 Sb., Synthetic dock statute",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versionValidFrom: "2024-01-01",
  versionValidTo: null,
} satisfies PublicStatute;
const olderStatute = {
  ...statute,
  effectiveDate: "2020-01-01",
  id: toSafeId<"legislationDocument">("019a0000-0000-7000-8000-000000000107"),
  status: "superseded",
  versionValidFrom: "2020-01-01",
  versionValidTo: "2023-12-31",
} satisfies PublicStatute;

const decisionParams = (value: PublicCaseLawDecision) =>
  createCaseLawDecisionRouteParams({
    caseNumber: value.caseNumber,
    country: value.country,
    court: value.court,
    decisionId: value.id,
    language: value.language,
    languageAlternates: value.languageAlternates,
    slug: value.slug,
  });
const statuteParams = createStatuteRouteParams({
  country: statute.country,
  documentId: statute.id,
  eli: statute.eli,
  slug: statute.slug,
  version: null,
});
const statuteVersionParams = createStatuteRouteParams({
  country: olderStatute.country,
  documentId: olderStatute.id,
  eli: olderStatute.eli,
  slug: olderStatute.slug,
  version: olderStatute.versionValidFrom,
});

export const DOCKED_CHAT_LEGAL_ROUTES = {
  decision: {
    params: decisionParams(decision),
    path: createCaseLawDecisionPath(decisionParams(decision)),
    id: decision.id,
  },
  bilingualDecision: {
    params: decisionParams(bilingualDecision),
    path: createCaseLawDecisionPath(decisionParams(bilingualDecision)),
    id: bilingualDecision.id,
  },
  statute: {
    params: statuteParams,
    path: createStatutePath(statuteParams),
    id: statute.id,
  },
  statuteVersion: {
    params: statuteVersionParams,
    path: createStatutePath(statuteVersionParams),
    id: olderStatute.id,
  },
};

/** Resolve each host template through the same canonical route owners as the readers. */
export const dockedLegalPath = (template: string): string => {
  if (template.includes("/cases/") && template.includes("$slug")) {
    const params = template.includes("$language")
      ? DOCKED_CHAT_LEGAL_ROUTES.bilingualDecision.params
      : DOCKED_CHAT_LEGAL_ROUTES.decision.params;
    return template.replaceAll(/\$([A-Za-z]+)/gu, (_, parameter: string) => {
      switch (parameter) {
        case "country":
          return params.country;
        case "court":
          return params.court;
        case "language":
          return (
            params.language ?? panic(`No fixture language for ${template}`)
          );
        case "slug":
          return params.slug;
        default:
          return panic(
            `Unknown docked legal route parameter ${parameter} (${template})`,
          );
      }
    });
  }
  const params = template.includes("$version")
    ? statuteVersionParams
    : statuteParams;
  return template.replaceAll(/\$([A-Za-z]+)/gu, (_, parameter: string) => {
    switch (parameter) {
      case "country":
        return params.country;
      case "slug":
        return params.slug;
      case "version":
        return (
          statuteVersionParams.version ??
          panic("Missing statute fixture version")
        );
      case "tableId":
        return "019a0000-0000-7000-8000-000000000106";
      default:
        return panic(
          `Unknown docked legal route parameter ${parameter} (${template})`,
        );
    }
  });
};

type DecisionReads = WebApiRoutes["case"]["decisions"][":decisionId"];
const noProvisions = {
  status: { type: "current" },
  generation: "synthetic-dock",
  publishedProjectionDigest: null,
  nextCursor: null,
  limit: 100,
  items: [],
  previews: [],
} satisfies DecisionReads["provisions"]["get"]["response"][200];
const noCitations = {
  nextCursor: null,
  limit: 50,
  items: [],
} satisfies DecisionReads["citations"]["get"]["response"][200];
const noLeadingCitations = {
  items: [],
} satisfies DecisionReads["citations"]["leading"]["get"]["response"][200];
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
  capped: { incoming: false, outgoing: false },
  incomingByYear: [],
} satisfies DecisionReads["citations"]["summary"]["get"]["response"][200];
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
} satisfies WebApiRoutes["law"]["statutes"][":documentId"]["versions"]["get"]["response"][200];

/** Exact HTTP reads only: the real route, reader, runtime and composer mount. */
export const installDockedLegalFixtures = async (page: Page) => {
  const reads = [
    { pathname: `/v1/law/statutes/${statute.id}`, body: statute },
    { pathname: `/v1/law/statutes/by-slug/${statute.slug}`, body: statute },
    { pathname: `/v1/law/statutes/${statute.id}/versions`, body: versions },
    { pathname: `/v1/law/statutes/${olderStatute.id}`, body: olderStatute },
    {
      pathname: `/v1/law/statutes/${olderStatute.id}/versions`,
      body: versions,
    },
    ...[decision, bilingualDecision, bilingualCzechDecision].flatMap(
      (value) => [
        { pathname: `/v1/case/decisions/${value.id}`, body: value },
        {
          pathname: `/v1/case/decisions/${value.id}/provisions`,
          body: noProvisions,
        },
        {
          pathname: `/v1/case/decisions/${value.id}/citations`,
          body: noCitations,
        },
        {
          pathname: `/v1/case/decisions/${value.id}/citations/leading`,
          body: noLeadingCitations,
        },
        {
          pathname: `/v1/case/decisions/${value.id}/citations/summary`,
          body: citationSummary,
        },
      ],
    ),
    { pathname: `/v1/case/decisions/by-slug/${decision.slug}`, body: decision },
    {
      pathname: `/v1/case/decisions/by-slug/${bilingualDecision.slug}`,
      body: bilingualDecision,
    },
  ];
  await page.route(
    (url) =>
      url.origin === E2E_API_ORIGIN &&
      reads.some(({ pathname }) => pathname === url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      const read =
        reads.find(({ pathname }) => pathname === url.pathname) ??
        panic(`Unregistered legal fixture read ${url.pathname}`);
      const body = (() => {
        if (
          url.pathname ===
            `/v1/case/decisions/by-slug/${bilingualDecision.slug}` &&
          url.searchParams.get("language") === "cs"
        ) {
          return bilingualCzechDecision;
        }
        if (
          url.pathname === `/v1/law/statutes/by-slug/${statute.slug}` &&
          url.searchParams.get("asOf") === olderStatute.versionValidFrom
        ) {
          return olderStatute;
        }
        return read.body;
      })();
      await route.fulfill({ json: body });
    },
  );
};
