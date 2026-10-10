import { Result } from "better-result";
import Elysia, { t } from "elysia";

import {
  readStatuteByEliHandler,
  readStatuteByEliQuerySchema,
} from "@/api/handlers/legislation/by-eli";
import {
  readStatuteBySlugHandler,
  readStatuteBySlugParamsSchema,
  readStatuteBySlugQuerySchema,
} from "@/api/handlers/legislation/by-slug";
import {
  listStatutesSuccessResponseSchema,
  legislationShelfSuccessResponseSchema,
  legislationFacetsSuccessResponseSchema,
  resolveStatutesSuccessResponseSchema,
  statuteSitemapShardsSuccessResponseSchema,
  statuteSitemapStatutesSuccessResponseSchema,
  publisherWindowInconsistentResponseSchema,
} from "@/api/handlers/legislation/catalog-response";
import {
  legislationFacetsQuerySchema,
  readLegislationFacetsHandler,
} from "@/api/handlers/legislation/facets";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import {
  listStatutesHandler,
  listStatutesQuerySchema,
} from "@/api/handlers/legislation/list";
import {
  provisionHistoryParamsSchema,
  provisionHistoryQuerySchema,
  readProvisionHistoryHandler,
} from "@/api/handlers/legislation/provision-history";
import readProvisionPreview from "@/api/handlers/legislation/provision-preview";
import searchPublicStatutes from "@/api/handlers/legislation/public-search";
import {
  statuteReaderSuccessResponseSchema,
  statuteVersionsSuccessResponseSchema,
  provisionHistorySuccessResponseSchema,
} from "@/api/handlers/legislation/reader-response";
import {
  resolveStatutesBodySchema,
  resolveStatutesHandler,
} from "@/api/handlers/legislation/resolve";
import {
  legislationShelfQuerySchema,
  readLegislationShelfHandler,
} from "@/api/handlers/legislation/shelf";
import {
  listStatuteSitemapShardsHandler,
  listStatuteSitemapStatutesHandler,
  sitemapShardStatutesQuerySchema,
} from "@/api/handlers/legislation/sitemap";
import {
  listStatuteVersionsHandler,
  listStatuteVersionsParamsSchema,
  listStatuteVersionsQuerySchema,
} from "@/api/handlers/legislation/versions";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { withPublicCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { safePublicHandlerErrorOrStatusTextResponseSchema } from "@/api/lib/search/public-error-response";

const listStatutes = createSafeBoundedPublicHandler(
  {
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        listStatutesSuccessResponseSchema,
      ),
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    query: listStatutesQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await listStatutesHandler(query, legislationPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const readLegislationShelf = createSafeBoundedPublicHandler(
  {
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        legislationShelfSuccessResponseSchema,
      ),
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    query: legislationShelfQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readLegislationShelfHandler(query, legislationPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const readLegislationFacets = createSafeBoundedPublicHandler(
  {
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        legislationFacetsSuccessResponseSchema,
      ),
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    query: legislationFacetsQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readLegislationFacetsHandler(query, legislationPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const readStatuteByEli = createSafeBoundedPublicHandler(
  {
    response: {
      ...safePublicHandlerResponseSchemasWithStatusText(
        statuteReaderSuccessResponseSchema,
      ),
      404: t.Union([
        safePublicHandlerErrorOrStatusTextResponseSchema,
        publisherWindowInconsistentResponseSchema,
      ]),
    },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "read_statute" },
    cache: { kind: "none" },
    query: readStatuteByEliQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readStatuteByEliHandler(query, legislationPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const resolveStatutes = createSafeBoundedPublicHandler(
  {
    response: safePublicHandlerResponseSchemasWithStatusText(
      resolveStatutesSuccessResponseSchema,
    ),
    // The batch form of `by-eli`: one read per Work is what `read_statute`
    // already answers, so an agent gains nothing from a second tool.
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "read_statute" },
    cache: { kind: "none" },
    body: resolveStatutesBodySchema,
  },
  async function* ({ body }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await resolveStatutesHandler(body, legislationPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const readStatuteBySlug = createSafeBoundedPublicHandler(
  {
    response: withPublicCountryUnavailable({
      ...safePublicHandlerResponseSchemasWithStatusText(
        statuteReaderSuccessResponseSchema,
      ),
      404: t.Union([
        safePublicHandlerErrorOrStatusTextResponseSchema,
        publisherWindowInconsistentResponseSchema,
      ]),
    }),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    params: readStatuteBySlugParamsSchema,
    query: readStatuteBySlugQuerySchema,
  },
  async function* ({ params, query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readStatuteBySlugHandler({
            legislationDb: legislationPublicReadDb,
            params,
            query,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readStatute = createSafeBoundedPublicHandler(
  {
    response: safePublicHandlerResponseSchemasWithStatusText(
      statuteReaderSuccessResponseSchema,
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "read_statute" },
    cache: { kind: "none" },
    params: t.Object({ documentId: tSafeId("legislationDocument") }),
  },
  async function* ({ params: { documentId } }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readPublicLegislationHandler(
            documentId,
            legislationPublicReadDb,
          ),
      ),
    );

    return Result.ok(response);
  },
);

const listStatuteVersions = createSafeBoundedPublicHandler(
  {
    response: safePublicHandlerResponseSchemasWithStatusText(
      statuteVersionsSuccessResponseSchema,
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "read_statute" },
    cache: { kind: "none" },
    params: listStatuteVersionsParamsSchema,
    query: listStatuteVersionsQuerySchema,
  },
  async function* ({ params: { documentId }, query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listStatuteVersionsHandler({
            documentId,
            query,
            legislationDb: legislationPublicReadDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readProvisionHistory = createSafeBoundedPublicHandler(
  {
    response: safePublicHandlerResponseSchemasWithStatusText(
      provisionHistorySuccessResponseSchema,
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "read_provision_history" },
    cache: { kind: "none" },
    params: provisionHistoryParamsSchema,
    query: provisionHistoryQuerySchema,
  },
  async function* ({ params: { documentId, anchor }, query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readProvisionHistoryHandler({
            documentId,
            anchor,
            query,
            legislationDb: legislationPublicReadDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const listStatuteSitemapShards = createSafeBoundedPublicHandler(
  {
    response: safePublicHandlerResponseSchemasWithStatusText(
      statuteSitemapShardsSuccessResponseSchema,
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
  },
  async function* () {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listStatuteSitemapShardsHandler(legislationPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const listStatuteSitemapStatutes = createSafeBoundedPublicHandler(
  {
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        statuteSitemapStatutesSuccessResponseSchema,
      ),
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "public_indexing" },
    cache: { kind: "none" },
    query: sitemapShardStatutesQuerySchema,
  },
  async function* ({ query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listStatuteSitemapStatutesHandler(
            query,
            legislationPublicReadDb,
          ),
      ),
    );

    return Result.ok(response);
  },
);

/**
 * Public-read routes: no auth, no session, no organization context.
 * Only sources cleared for redistribution are readable.
 */
export const publicLegislationRoute = new Elysia({
  prefix: "/law",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
    ),
  )
  .get("/statutes", listStatutes.handler, {
    query: listStatutes.config.query,
    response: listStatutes.config.response,
  })
  .get("/statutes/search", searchPublicStatutes.handler, {
    query: searchPublicStatutes.config.query,
    response: searchPublicStatutes.config.response,
  })
  // Ahead of `/statutes/:documentId` for the same reason as `by-eli` below.
  .get("/statutes/shelf", readLegislationShelf.handler, {
    query: readLegislationShelf.config.query,
    response: readLegislationShelf.config.response,
  })
  // Ahead of `/statutes/:documentId` for the same reason as `by-eli` below.
  .get("/statutes/facets", readLegislationFacets.handler, {
    query: readLegislationFacets.config.query,
    response: readLegislationFacets.config.response,
  })
  // Ahead of `/statutes/:documentId`, or the literal segment would be read as
  // a document id and rejected by the UUID schema.
  .get("/statutes/by-eli", readStatuteByEli.handler, {
    query: readStatuteByEli.config.query,
    response: readStatuteByEli.config.response,
  })
  .post("/statutes/resolve", resolveStatutes.handler, {
    body: resolveStatutes.config.body,
    response: resolveStatutes.config.response,
  })
  // Ahead of `/statutes/:documentId` for the same reason: `by-slug` is a
  // literal segment, not a document id.
  .get("/statutes/by-slug/:slug", readStatuteBySlug.handler, {
    params: readStatuteBySlug.config.params,
    query: readStatuteBySlug.config.query,
    response: readStatuteBySlug.config.response,
  })
  .get("/statutes/:documentId", readStatute.handler, {
    params: readStatute.config.params,
    response: readStatute.config.response,
  })
  .get("/statutes/:documentId/versions", listStatuteVersions.handler, {
    params: listStatuteVersions.config.params,
    query: listStatuteVersions.config.query,
    response: listStatuteVersions.config.response,
  })
  .get(
    "/statutes/:documentId/provisions/:anchor/preview",
    readProvisionPreview.handler,
    {
      params: readProvisionPreview.config.params,
      query: readProvisionPreview.config.query,
      response: readProvisionPreview.config.response,
    },
  )
  .get(
    "/statutes/:documentId/provisions/:anchor/history",
    readProvisionHistory.handler,
    {
      params: readProvisionHistory.config.params,
      query: readProvisionHistory.config.query,
      response: readProvisionHistory.config.response,
    },
  )
  .get("/sitemap/shards", listStatuteSitemapShards.handler, {
    response: listStatuteSitemapShards.config.response,
  })
  .get("/sitemap/statutes/shard", listStatuteSitemapStatutes.handler, {
    query: listStatuteSitemapStatutes.config.query,
    response: listStatuteSitemapStatutes.config.response,
  });
