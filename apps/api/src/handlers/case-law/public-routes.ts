import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import {
  listDecisionFacetsHandler,
  listDecisionFacetsQuerySchema,
} from "@/api/handlers/case-law/decisions/facets";
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
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
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

export const readStatuteCitationCounts = createSafeBoundedPublicHandler(
  {
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

const listDecisionFacets = createSafeBoundedPublicHandler(
  {
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
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "read_case_law_decision" },
    cache: { kind: "none" },
    params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
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
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "read_case_law_decision" },
    cache: { kind: "none" },
    params: t.Object({ slug: t.String({ minLength: 1, maxLength: 256 }) }),
    response: withPublicCountryUnavailable(readDecisionResponseSchema),
    query: t.Composite([
      readDecisionQuerySchema,
      t.Object({
        country: tPublicLawCountry,
        language: t.Optional(t.String({ minLength: 2, maxLength: 8 })),
      }),
    ]),
  },
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { slug }, query: { country, language } }) => {
    const countryRead = readPublicLawCountry(country, {
      admitted: PUBLIC_CASE_LAW_COUNTRIES,
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
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      decisionProvisionsSuccessResponseSchema,
    ),
    params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
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
          await listCitingDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(
      projectResponseText(response, citingDecisionsSuccessResponseSchema),
    );
  },
);

const searchDecisions = createSafeBoundedPublicHandler(
  {
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "search_case_law" },
    cache: { kind: "none" },
    body: searchDecisionsBodySchema,
    response: searchDecisionsResponseSchema,
  },
  async function* ({ body }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchDecisionsHandler({
            body,
            caseLawDb: caseLawPublicReadDb,
            observer: "unobserved",
          }),
      ),
    );

    return Result.ok(response);
  },
);

const listSitemapShardDecisions = createSafeBoundedPublicHandler(
  {
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
export const publicCaseLawRoute = new Elysia({
  prefix: "/case",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
    ),
  )
  .get("/coverage", readCaseLawCoverage.handler, {
    response: readCaseLawCoverage.config.response,
  })
  .get("/decisions", listDecisions.handler, {
    query: listDecisions.config.query,
    response: listDecisions.config.response,
  })
  .get("/decisions/facets", listDecisionFacets.handler, {
    query: listDecisionFacets.config.query,
    response: listDecisionFacets.config.response,
  })
  .get("/decisions/status", readCaseLawCorpusStatus.handler, {
    query: readCaseLawCorpusStatus.config.query,
    response: readCaseLawCorpusStatus.config.response,
  })
  .get("/decisions/latest", listLatestDecisions.handler, {
    query: listLatestDecisions.config.query,
    response: listLatestDecisions.config.response,
  })
  .get("/decisions/by-slug/:slug", readDecisionBySlug.handler, {
    params: readDecisionBySlug.config.params,
    query: readDecisionBySlug.config.query,
    response: readDecisionBySlug.config.response,
  })
  .get("/decisions/:decisionId", readDecision.handler, {
    params: readDecision.config.params,
    query: readDecision.config.query,
    response: readDecision.config.response,
  })
  .get("/decisions/:decisionId/citations", listDecisionCitations.handler, {
    params: listDecisionCitations.config.params,
    query: listDecisionCitations.config.query,
    response: listDecisionCitations.config.response,
  })
  .get(
    "/decisions/:decisionId/citations/summary",
    summarizeDecisionCitations.handler,
    {
      params: summarizeDecisionCitations.config.params,
      response: summarizeDecisionCitations.config.response,
    },
  )
  .get(
    "/decisions/:decisionId/citations/leading",
    listLeadingCitations.handler,
    {
      params: listLeadingCitations.config.params,
      query: listLeadingCitations.config.query,
      response: listLeadingCitations.config.response,
    },
  )
  .get("/decisions/:decisionId/provisions", listDecisionProvisions.handler, {
    params: listDecisionProvisions.config.params,
    query: listDecisionProvisions.config.query,
    response: listDecisionProvisions.config.response,
  })
  .get("/judges/:judgeId/portrait", readJudgePortrait.handler, {
    params: readJudgePortrait.config.params,
  })
  .get("/provisions/citing-decisions", listCitingDecisions.handler, {
    query: listCitingDecisions.config.query,
    response: listCitingDecisions.config.response,
  })
  .get("/provisions/citation-counts", readStatuteCitationCounts.handler, {
    query: readStatuteCitationCounts.config.query,
    response: readStatuteCitationCounts.config.response,
  })
  .post("/decisions/search", searchDecisions.handler, {
    body: searchDecisions.config.body,
    response: searchDecisions.config.response,
  })
  .get("/sitemap/shards", listSitemapShards.handler, {
    response: listSitemapShards.config.response,
  })
  .get("/sitemap/decisions/shard", listSitemapShardDecisions.handler, {
    query: listSitemapShardDecisions.config.query,
    response: listSitemapShardDecisions.config.response,
  });
