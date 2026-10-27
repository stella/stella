import { Result } from "better-result";
import * as v from "valibot";

import { caseLawFilterValidationSchema } from "@stll/api-contract/case-law-filter-scope";
import { PUBLIC_CASE_LAW_PAGE_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import {
  listDecisionFacetsHandler,
  listDecisionFacetsQuerySchema,
} from "@/api/handlers/case-law/decisions/facets";
import {
  decisionFilterValidationHandler,
  decisionFilterValidationQuerySchema,
} from "@/api/handlers/case-law/decisions/filter-validation";
import {
  readDecisionHandler,
  readDecisionQuerySchema,
} from "@/api/handlers/case-law/decisions/get";
import { hydrateDeferredDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import {
  listLatestDecisionsHandler,
  listLatestDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/latest";
import listLeadingCitations from "@/api/handlers/case-law/decisions/leading-citations";
import {
  listDecisionsHandler,
  listDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/list";
import listDecisionCitations from "@/api/handlers/case-law/decisions/list-citations";
import { createSafePublicSubjectFollowUpHandler } from "@/api/handlers/case-law/decisions/public-subject";
import readCaseLawCoverage from "@/api/handlers/case-law/decisions/read-coverage";
import {
  projectDecisionReader,
  readDecisionResponseSchema,
} from "@/api/handlers/case-law/decisions/read-response";
import { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import {
  searchDecisionsBodySchema,
  searchDecisionsResponseSchema,
} from "@/api/handlers/case-law/decisions/search-schema";
import {
  listSitemapShardDecisionsHandler,
  listSitemapShardsHandler,
  sitemapShardDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/sitemap";
import {
  readCaseLawCorpusStatusHandler,
  readCaseLawCorpusStatusQuerySchema,
} from "@/api/handlers/case-law/decisions/status";
import summarizeDecisionCitations from "@/api/handlers/case-law/decisions/summarize-citations";
import readDecisionSummaryRoute from "@/api/handlers/case-law/decisions/summary/get";
import readJudgePortrait from "@/api/handlers/case-law/judges/read-portrait";
import {
  readStatuteCitationCountsHandler,
  statuteCitationCountsQuerySchema,
} from "@/api/handlers/case-law/provisions/citation-counts";
import {
  listCitingDecisionsHandler,
  listCitingDecisionsQuerySchema,
} from "@/api/handlers/case-law/provisions/citing-decisions";
import {
  listDecisionProvisionsHandler,
  listDecisionProvisionsQuerySchema,
} from "@/api/handlers/case-law/provisions/list-for-decision";
import {
  attachDecisionProvisionPreviews,
  readDecisionDate,
} from "@/api/handlers/case-law/provisions/previews-for-decision";
import { projectProvisionPreview } from "@/api/handlers/case-law/provisions/response";
import {
  citationCountsSuccessResponseSchema,
  citingDecisionsSuccessResponseSchema,
  decisionProvisionsSuccessResponseSchema,
} from "@/api/handlers/case-law/provisions/response-schema";
import {
  corpusStatusResponseSchema,
  decisionFacetsResponseSchema,
  latestDecisionsResponseSchema,
  listDecisionsResponseSchema,
  sitemapDecisionsResponseSchema,
  sitemapShardsResponseSchema,
} from "@/api/handlers/case-law/public-response-schemas";
import { routes } from "@/api/http/route";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readCourtRegistry } from "@/api/lib/case-law/court-presentation";
import { loadPublicCourtWeights } from "@/api/lib/case-law/public-case-law-config";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import {
  readPublicLawCountry,
  tPublicLawCountry,
  withPublicCountryUnavailable,
} from "@/api/lib/legal-search/public-law-country";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { projectResponseText } from "@/api/lib/search/project-response-text";

const listDecisions = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        listDecisionsResponseSchema,
      ),
    ),
    query: listDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await listDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(
      projectResponseText(
        "items" in response
          ? {
              ...response,
              items: response.items.map((item) => ({
                ...item,
                createdAt: item.createdAt.toISOString(),
              })),
            }
          : response,
        listDecisionsResponseSchema,
      ),
    );
  },
);

const readStatuteCitationCounts = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        citationCountsSuccessResponseSchema,
      ),
    ),
    query: statuteCitationCountsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readStatuteCitationCountsHandler(query, caseLawPublicReadDb),
      ),
    );
    return Result.ok(
      projectResponseText(response, citationCountsSuccessResponseSchema),
    );
  },
);

const validateDecisionFilters = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        caseLawFilterValidationSchema,
      ),
    ),
    query: decisionFilterValidationQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await decisionFilterValidationHandler(query),
      ),
    );
    return Result.ok(
      projectResponseText(response, caseLawFilterValidationSchema),
    );
  },
);

const listDecisionFacets = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        decisionFacetsResponseSchema,
      ),
    ),
    query: listDecisionFacetsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(async () => await listDecisionFacetsHandler(query)),
    );

    return Result.ok(
      projectResponseText(response, decisionFacetsResponseSchema),
    );
  },
);

const listLatestDecisions = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        latestDecisionsResponseSchema,
      ),
    ),
    query: listLatestDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listLatestDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(
      projectResponseText(response, latestDecisionsResponseSchema),
    );
  },
);

const readCaseLawCorpusStatus = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        corpusStatusResponseSchema,
      ),
    ),
    query: readCaseLawCorpusStatusQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readCaseLawCorpusStatusHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(projectResponseText(response, corpusStatusResponseSchema));
  },
);

const readDecision = createSafePublicSubjectFollowUpHandler({
  config: {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "read_case_law_decision" },
    cache: { kind: "none" },
    params: v.object({ decisionId: resourceIdSchema("caseLawDecision") }),
    query: readDecisionQuerySchema,
    response: readDecisionResponseSchema,
  },
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject, { query: { citationsCursor } }) =>
    await readDecisionHandler({ subject, citationsCursor }),
  // Unauthenticated: hydrates when a slot is free, but never persists
  // demand — see `recordDemand`. Runs after the gated transaction closes.
  followUp: async (read) => {
    const hydrated = await hydrateDeferredDocument(read, false, {
      type: "on-demand",
      permit: grantThirdPartyOutboundPermit(),
    });
    return "documentPending" in hydrated
      ? projectDecisionReader(hydrated)
      : hydrated;
  },
});

const readDecisionBySlug = createSafePublicSubjectFollowUpHandler({
  config: {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "read_case_law_decision" },
    cache: { kind: "none" },
    params: v.object({
      slug: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    }),
    response: withPublicCountryUnavailable(readDecisionResponseSchema),
    query: v.object({
      ...readDecisionQuerySchema.entries,
      country: tPublicLawCountry,
      language: v.optional(v.pipe(v.string(), v.minLength(2), v.maxLength(8))),
    }),
  },
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { slug }, query: { country, language } }) => {
    const countryRead = readPublicLawCountry(country, {
      domain: "caseLaw",
      admitted: PUBLIC_CASE_LAW_PAGE_COUNTRIES,
      surface: "pages",
    });
    return countryRead.kind !== "read"
      ? countryRead
      : { kind: "slug", country: countryRead.country, slug, language };
  },
  read: async (subject, { query: { citationsCursor } }) =>
    await readDecisionHandler({ subject, citationsCursor }),
  followUp: async (read) => {
    const hydrated = await hydrateDeferredDocument(read, false, {
      type: "on-demand",
      permit: grantThirdPartyOutboundPermit(),
    });
    return "documentPending" in hydrated
      ? projectDecisionReader(hydrated)
      : hydrated;
  },
});

const projectDecisionProvisionPage = async (
  page: Extract<
    Awaited<ReturnType<typeof listDecisionProvisionsHandler>>,
    { items: unknown[] }
  >,
  decisionDate: string | null,
) => {
  const withPreviews = await attachDecisionProvisionPreviews({
    page,
    decisionDate,
    legislationDb: legislationPublicReadDb,
    surface: "pages",
  });
  return projectResponseText(
    {
      ...page,
      ...withPreviews,
      previews: withPreviews.previews.map(projectProvisionPreview),
    },
    decisionProvisionsSuccessResponseSchema,
  );
};

/**
 * Provision references of a decision, each with the wording it points at.
 *
 * The previews are attached after the gated transaction closes: they are read
 * from object storage, which must not hold one open.
 */
const listDecisionProvisions = createSafePublicSubjectFollowUpHandler({
  config: {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      decisionProvisionsSuccessResponseSchema,
    ),
    params: v.object({ decisionId: resourceIdSchema("caseLawDecision") }),
    query: listDecisionProvisionsQuerySchema,
  },
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject, { query }) => ({
    page: await listDecisionProvisionsHandler({ subject, query }),
    decisionDate: await readDecisionDate(subject),
  }),
  followUp: async ({ page, decisionDate }) =>
    "items" in page
      ? await projectDecisionProvisionPage(page, decisionDate)
      : page,
});

/** Decisions citing a provision. */
const listCitingDecisions = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        citingDecisionsSuccessResponseSchema,
      ),
    ),
    query: listCitingDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listCitingDecisionsHandler(query, {
            caseLawDb: caseLawPublicReadDb,
            courtRegistry: await readCourtRegistry(loadPublicCourtWeights),
          }),
      ),
    );

    return Result.ok(
      projectResponseText(response, citingDecisionsSuccessResponseSchema),
    );
  },
);

const searchDecisions = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "search_case_law" },
    cache: { kind: "none" },
    body: searchDecisionsBodySchema,
    response: searchDecisionsResponseSchema,
  },
  async function* ({ body, request }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchDecisionsHandler({
            body,
            caseLawDb: caseLawPublicReadDb,
            observer: "unobserved",
            signal: request.signal,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const listSitemapShardDecisions = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        sitemapDecisionsResponseSchema,
      ),
    ),
    query: sitemapShardDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listSitemapShardDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(
      projectResponseText(
        "items" in response
          ? {
              ...response,
              items: response.items.map((item) => ({
                ...item,
                updatedAt: item.updatedAt.toISOString(),
                languageAlternates: item.languageAlternates.map(
                  (alternate) => ({
                    ...alternate,
                    updatedAt: alternate.updatedAt.toISOString(),
                  }),
                ),
              })),
            }
          : response,
        sitemapDecisionsResponseSchema,
      ),
    );
  },
);

const listSitemapShards = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      sitemapShardsResponseSchema,
    ),
  },
  async function* () {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await listSitemapShardsHandler(caseLawPublicReadDb),
      ),
    );

    return Result.ok(
      projectResponseText(response, sitemapShardsResponseSchema),
    );
  },
);

/**
 * Public-read routes: no auth, no session, no organization context.
 * Decisions are public records; protected workspace features live elsewhere.
 */
export const publicCaseLawRoute = routes(
  {
    "/coverage": { GET: readCaseLawCoverage },
    "/decisions": { GET: listDecisions },
    "/decisions/facets": { GET: listDecisionFacets },
    "/decisions/filter-validation": { GET: validateDecisionFilters },
    "/decisions/status": { GET: readCaseLawCorpusStatus },
    "/decisions/latest": { GET: listLatestDecisions },
    "/decisions/by-slug/:slug": { GET: readDecisionBySlug },
    "/decisions/:decisionId": { GET: readDecision },
    "/decisions/:decisionId/citations": { GET: listDecisionCitations },
    "/decisions/:decisionId/citations/summary": {
      GET: summarizeDecisionCitations,
    },
    "/decisions/:decisionId/citations/leading": { GET: listLeadingCitations },
    "/decisions/:decisionId/provisions": { GET: listDecisionProvisions },
    "/decisions/:decisionId/summary": { GET: readDecisionSummaryRoute },
    "/judges/:judgeId/portrait": { GET: readJudgePortrait },
    "/provisions/citing-decisions": { GET: listCitingDecisions },
    "/provisions/citation-counts": { GET: readStatuteCitationCounts },
    "/decisions/search": { POST: searchDecisions },
    "/sitemap/shards": { GET: listSitemapShards },
    "/sitemap/decisions/shard": { GET: listSitemapShardDecisions },
  },
  {
    prefix: "/case",
    middleware: [deploymentFeatureGate("FEATURE_PUBLIC_LAW")],
  },
);
