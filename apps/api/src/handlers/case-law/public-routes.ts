import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { env } from "@/api/env";
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
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

const listDecisions = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    query: listDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await listDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

export const readStatuteCitationCounts = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    query: statuteCitationCountsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readStatuteCitationCountsHandler(query, caseLawPublicReadDb),
      ),
    );
    return Result.ok(response);
  },
);

const listDecisionFacets = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    query: listDecisionFacetsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(async () => await listDecisionFacetsHandler(query)),
    );

    return Result.ok(response);
  },
);

const listLatestDecisions = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    query: listLatestDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listLatestDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const readCaseLawCorpusStatus = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    query: readCaseLawCorpusStatusQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readCaseLawCorpusStatusHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const readDecision = createSafePublicSubjectFollowUpHandler({
  config: {
    mcp: { type: "tool", name: "read_case_law_decision" },
    params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
    query: readDecisionQuerySchema,
  },
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject, { query: { citationsCursor } }) =>
    await readDecisionHandler({ subject, citationsCursor }),
  // Unauthenticated: hydrates when a slot is free, but never persists
  // demand — see `recordDemand`. Runs after the gated transaction closes.
  followUp: async (read) => await hydrateDeferredDocument(read, false),
});

const readDecisionBySlug = createSafePublicSubjectFollowUpHandler({
  config: {
    mcp: { type: "covered", by: "read_case_law_decision" },
    params: t.Object({ slug: t.String({ minLength: 1, maxLength: 256 }) }),
    query: t.Composite([
      readDecisionQuerySchema,
      t.Object({
        country: t.String({ minLength: 2, maxLength: 3 }),
        language: t.Optional(t.String({ minLength: 2, maxLength: 8 })),
      }),
    ]),
  },
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { slug }, query: { country, language } }) => ({
    kind: "slug",
    country,
    slug,
    language,
  }),
  read: async (subject, { query: { citationsCursor } }) =>
    await readDecisionHandler({ subject, citationsCursor }),
  followUp: async (read) => await hydrateDeferredDocument(read, false),
});

/**
 * Provision references of a decision, each with the wording it points at.
 *
 * The previews are attached after the gated transaction closes: they are read
 * from object storage, which must not hold one open.
 */
const listDecisionProvisions = createSafePublicSubjectFollowUpHandler({
  config: {
    mcp: { type: "internal", reason: "public_indexing" },
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
      ? await attachDecisionProvisionPreviews({
          page,
          decisionDate,
          legislationDb: legislationPublicReadDb,
        })
      : page,
});

/** Decisions citing a provision. */
const listCitingDecisions = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    query: listCitingDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listCitingDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const searchDecisions = createSafePublicHandler(
  {
    mcp: { type: "tool", name: "search_case_law" },
    body: searchDecisionsBodySchema,
    response: searchDecisionsResponseSchema,
  },
  async function* ({ body }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await searchDecisionsHandler(body, caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const listSitemapShardDecisions = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    query: sitemapShardDecisionsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listSitemapShardDecisionsHandler(query, caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const listSitemapShards = createSafePublicHandler(
  { mcp: { type: "internal", reason: "public_indexing" } },
  async function* () {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await listSitemapShardsHandler(caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

/**
 * Public-read routes: no auth, no session, no organization context.
 * Decisions are public records; protected workspace features live elsewhere.
 */
export const publicCaseLawRoute = new Elysia({
  prefix: "/case",
})
  .onBeforeHandle(({ set }) => {
    if (env.isDev || env.FEATURE_PUBLIC_LAW) {
      return undefined;
    }

    set.status = 404;
    return { error: "Not Found" } as const;
  })
  .get("/decisions", listDecisions.handler, {
    query: listDecisions.config.query,
  })
  .get("/decisions/facets", listDecisionFacets.handler, {
    query: listDecisionFacets.config.query,
  })
  .get("/decisions/status", readCaseLawCorpusStatus.handler, {
    query: readCaseLawCorpusStatus.config.query,
  })
  .get("/decisions/latest", listLatestDecisions.handler, {
    query: listLatestDecisions.config.query,
  })
  .get("/decisions/by-slug/:slug", readDecisionBySlug.handler, {
    params: readDecisionBySlug.config.params,
    query: readDecisionBySlug.config.query,
  })
  .get("/decisions/:decisionId", readDecision.handler, {
    params: readDecision.config.params,
    query: readDecision.config.query,
  })
  .get("/decisions/:decisionId/citations", listDecisionCitations.handler, {
    params: listDecisionCitations.config.params,
    query: listDecisionCitations.config.query,
  })
  .get(
    "/decisions/:decisionId/citations/summary",
    summarizeDecisionCitations.handler,
    { params: summarizeDecisionCitations.config.params },
  )
  .get(
    "/decisions/:decisionId/citations/leading",
    listLeadingCitations.handler,
    {
      params: listLeadingCitations.config.params,
      query: listLeadingCitations.config.query,
    },
  )
  .get("/decisions/:decisionId/provisions", listDecisionProvisions.handler, {
    params: listDecisionProvisions.config.params,
    query: listDecisionProvisions.config.query,
  })
  .get("/provisions/citing-decisions", listCitingDecisions.handler, {
    query: listCitingDecisions.config.query,
  })
  .get("/provisions/citation-counts", readStatuteCitationCounts.handler, {
    query: readStatuteCitationCounts.config.query,
  })
  .post("/decisions/search", searchDecisions.handler, {
    body: searchDecisions.config.body,
    response: searchDecisions.config.response,
  })
  .get("/sitemap/shards", listSitemapShards.handler)
  .get("/sitemap/decisions/shard", listSitemapShardDecisions.handler, {
    query: listSitemapShardDecisions.config.query,
  });
