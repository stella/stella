import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { PublicStatute } from "@/features/statutes/queries/statutes";
import type { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import type { Route as StatuteRoute } from "@/routes/law/$country/statutes/$slug/index";

export const publicRouteExceptions: Record<string, string> = {
  "/": "RootRedirect immediately navigates according to the audience; it has no stable leaf body. Destination routes are covered separately.",
  "/auth/handoff":
    "The handoff confirmation route requires root-loader state captured from an MCP handoff; its panel is covered separately.",
  "/knowledge/clauses:anonymous":
    "KnowledgeMemberOnly redirects anonymous visitors to the Knowledge landing before its page body mounts.",
  "/knowledge/styles:anonymous":
    "KnowledgeMemberOnly redirects anonymous visitors to the Knowledge landing before its page body mounts.",
  "/knowledge/workflows:anonymous":
    "KnowledgeMemberOnly redirects anonymous visitors to the Knowledge landing before its page body mounts.",
  "/knowledge/company-formats/$registry/$companyId:anonymous":
    "KnowledgeMemberOnly redirects anonymous visitors to the Knowledge landing before its page body mounts.",
};

const absentText = { type: "absent", reason: "not_published" } as const;

const decision = {
  caseNumber: "SYN 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationCount: 0,
  citationsFrom: [],
  citationsNextCursor: null,
  citationsTo: [],
  country: "CZE",
  court: "Fixture court",
  courtId: null,
  courtAbbreviation: null,
  courtTier: "other",
  createdAt: "2026-01-01T00:00:00.000Z",
  decisionDate: null,
  decisionType: null,
  documentAst: null,
  documentAstSource: null,
  projectionDigest: null,
  hasDocument: true,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  documentUrl: null,
  ecli: null,
  fulltext: "Fixture decision text.",
  headnote: absentText,
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000011"),
  identifiers: [
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "SYN 1/2026" },
  ],
  judges: [],
  language: "cs",
  languageAlternates: [],
  languageGroupKey: null,
  metadata: {},
  resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
  sections: null,
  slug: "fixture",
  source: {
    adapterKey: "fixture",
    allowsDerivedAi: true,
    id: toSafeId<"caseLawSource">("00000000-0000-4000-8000-000000000012"),
    name: "Fixture source",
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

const statute = {
  pendingChanges: null,
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
  effectiveDate: "2026-01-01",
  eli: "/eli/cz/sb/2026/1",
  fulltext: "§ 1\nFixture provision.",
  id: toSafeId<"legislationDocument">("00000000-0000-4000-8000-000000000013"),
  language: "cs",
  sections: null,
  slug: "fixture",
  sourceUrl: null,
  status: "current",
  title: "1/2026 Sb., Fixture act",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versionValidFrom: "2026-01-01",
  versionValidTo: null,
} satisfies PublicStatute;

const statuteData = {
  statute,
  versions: [],
  windowGap: null,
  work: statute,
} satisfies typeof StatuteRoute.types.loaderData;

export const publicFixtureLoaderData = (routeId: string) => {
  switch (routeId) {
    case "/law/$country/cases/$court/$slug":
    case "/law/$country/cases/$court/$language/$slug":
      return decision;
    case "/law/$country/statutes/$slug/":
    case "/law/$country/statutes/$slug/v/$version":
      return statuteData;
    default:
      return undefined;
  }
};

type DecisionEndpoint = ReturnType<typeof api.case.decisions>;
const emptyTreatments = {
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  mixed: 0,
  unclassified: 0,
};

export const publicFixtureResponse = (
  pathname: string,
): Response | undefined => {
  switch (pathname) {
    case "/v1/mcp/connectors":
      return Response.json({
        canManageCustomConnectors: false,
        connectors: [],
        nativeTools: [],
      } satisfies NonNullable<
        Awaited<ReturnType<typeof api.mcp.connectors.get>>["data"]
      >);
    case "/v1/case/research/columns":
      return Response.json({ items: [] } satisfies NonNullable<
        Awaited<ReturnType<typeof api.case.research.columns.get>>["data"]
      >);
    case "/v1/contacts/00000000-0000-4000-8000-000000000003":
      return Response.json({
        id: toSafeId<"contact">("00000000-0000-4000-8000-000000000003"),
        organizationId: toSafeId<"organization">("org-fixture"),
        type: "person",
        prefix: null,
        firstName: "Fixture",
        middleName: null,
        lastName: "Contact",
        suffix: null,
        dateOfBirth: null,
        nationalityCodes: [],
        organizationName: null,
        sanctionsMonitoringMode: "included",
        displayName: "Fixture contact",
        notes: null,
        emails: [],
        phones: [],
        addresses: [],
        tags: [],
        metadata: null,
        color: null,
        registrationNumber: null,
        taxId: null,
        bankAccounts: [],
        billingAddress: null,
        defaultHourlyRate: null,
        currency: null,
        paymentTermDays: null,
        originatingAttorneyId: null,
        responsibleAttorneyId: null,
        createdBy: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        originatingAttorney: null,
        responsibleAttorney: null,
        clientMatterCount: 0,
        clientMatters: [],
        partyMatters: [],
        partyCount: 0,
      } satisfies NonNullable<
        Awaited<ReturnType<ReturnType<typeof api.contacts>["get"]>>["data"]
      >);
    case "/v1/case/decisions":
      return Response.json({
        items: [],
        limit: 25,
        nextCursor: null,
      } satisfies NonNullable<
        Awaited<ReturnType<typeof api.case.decisions.get>>["data"]
      >);
    case "/v1/case/decisions/facets":
      return Response.json({
        country: [],
        court: [],
        year: [],
      } satisfies NonNullable<
        Awaited<ReturnType<typeof api.case.decisions.facets.get>>["data"]
      >);
    case "/v1/case/coverage":
      return Response.json({
        message: "Coverage is unavailable",
      } satisfies NonNullable<
        Awaited<ReturnType<typeof api.case.coverage.get>>["data"]
      >);
    case "/v1/law/statutes":
      return Response.json({
        items: [],
        limit: 25,
        nextCursor: null,
      } satisfies NonNullable<
        Awaited<ReturnType<typeof api.law.statutes.get>>["data"]
      >);
    case "/v1/law/statutes/facets":
      return Response.json({ documentType: [] } satisfies NonNullable<
        Awaited<ReturnType<typeof api.law.statutes.facets.get>>["data"]
      >);
    case "/v1/reader/answers":
      return Response.json({
        items: [],
        limit: 50,
        nextCursor: null,
      } satisfies NonNullable<
        Awaited<ReturnType<typeof api.reader.answers.get>>["data"]
      >);
    case "/v1/reader/annotations":
      return Response.json({
        items: [],
        limit: 100,
        nextCursor: null,
      } satisfies NonNullable<
        Awaited<ReturnType<typeof api.reader.annotations.get>>["data"]
      >);
    case `/v1/chat/decision-threads/${decision.id}`:
      return Response.json({ threadId: null } satisfies NonNullable<
        Awaited<
          ReturnType<ReturnType<(typeof api.chat)["decision-threads"]>["get"]>
        >["data"]
      >);
    case "/v1/case/provisions/citation-counts":
      return Response.json({
        status: "ready",
        provisions: [],
      } satisfies NonNullable<
        Awaited<
          ReturnType<(typeof api.case.provisions)["citation-counts"]["get"]>
        >["data"]
      >);
    case `/v1/case/decisions/${decision.id}`:
      return Response.json(decision);
    case `/v1/law/statutes/${statute.id}`:
      return Response.json(statute);
    case `/v1/case/decisions/${decision.id}/citations/summary`:
      return Response.json({
        incoming: emptyTreatments,
        outgoing: emptyTreatments,
        precision: { status: "exact" },
        incomingByYear: [],
      } satisfies NonNullable<
        Awaited<
          ReturnType<DecisionEndpoint["citations"]["summary"]["get"]>
        >["data"]
      >);
    case `/v1/case/decisions/${decision.id}/citations`:
      return Response.json({
        items: [],
        limit: 25,
        nextCursor: null,
        doctrineAvailability: "available",
      } satisfies NonNullable<
        Awaited<ReturnType<DecisionEndpoint["citations"]["get"]>>["data"]
      >);
    case `/v1/case/decisions/${decision.id}/citations/leading`:
      return Response.json({ items: [] } satisfies NonNullable<
        Awaited<
          ReturnType<DecisionEndpoint["citations"]["leading"]["get"]>
        >["data"]
      >);
    case `/v1/case/decisions/${decision.id}/provisions`:
      return Response.json({
        items: [],
        limit: 50,
        nextCursor: null,
        status: { type: "current" },
        capability: { type: "supported", languages: ["cs"] },
        pendingSince: null,
        generation: "1",
        publishedProjectionDigest: null,
        previews: [],
      } satisfies NonNullable<
        Awaited<ReturnType<DecisionEndpoint["provisions"]["get"]>>["data"]
      >);
    default:
      return undefined;
  }
};

export const publicFixtureReadyText = (routeId: string) => {
  const data = publicFixtureLoaderData(routeId);
  if (data === undefined) {
    return undefined;
  }
  return "statute" in data
    ? data.statute.fulltext.split("\n").at(-1)
    : data.fulltext;
};

export const publicFixtureReadySelector = (
  routeId: string,
  audience: "member" | "anonymous",
) => {
  if (publicFixtureLoaderData(routeId) === undefined) {
    return undefined;
  }
  return audience === "member"
    ? '[data-slot="workspace-shell-main"] [data-file-viewer-root] [contenteditable="true"]'
    : '[data-slot="workspace-shell-main"] [data-file-viewer-root] [data-slot="gated-chat-sign-in"]';
};
