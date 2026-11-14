import { Result } from "better-result";
import * as v from "valibot";

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
  legislationFacetsSuccessResponseSchema,
  legislationShelfSuccessResponseSchema,
  listStatutesSuccessResponseSchema,
  publisherWindowInconsistentResponseSchema,
  resolveStatutesSuccessResponseSchema,
  statuteSitemapShardsSuccessResponseSchema,
  statuteSitemapStatutesSuccessResponseSchema,
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
  provisionHistorySuccessResponseSchema,
  statuteReaderSuccessResponseSchema,
  statuteVersionsSuccessResponseSchema,
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
import { routes } from "@/api/http/route";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { withPublicCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { safePublicHandlerErrorOrStatusTextResponseSchema } from "@/api/lib/search/public-error-response";

const listStatutes = createSafeBoundedPublicHandler(
  {
    contract: "patch",
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
    contract: "patch",
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
    contract: "patch",
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
    contract: "patch",
    response: {
      ...safePublicHandlerResponseSchemasWithStatusText(
        statuteReaderSuccessResponseSchema,
      ),
      404: v.union([
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
    contract: "patch",
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
    contract: "patch",
    response: withPublicCountryUnavailable({
      ...safePublicHandlerResponseSchemasWithStatusText(
        statuteReaderSuccessResponseSchema,
      ),
      404: v.union([
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
    contract: "patch",
    response: safePublicHandlerResponseSchemasWithStatusText(
      statuteReaderSuccessResponseSchema,
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "read_statute" },
    cache: { kind: "none" },
    params: v.object({ documentId: resourceIdSchema("legislationDocument") }),
  },
  async function* ({ params: { documentId } }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readPublicLegislationHandler(
            documentId,
            legislationPublicReadDb,
            "pages",
          ),
      ),
    );

    return Result.ok(response);
  },
);

const listStatuteVersions = createSafeBoundedPublicHandler(
  {
    contract: "patch",
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
            surface: "pages",
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readProvisionHistory = createSafeBoundedPublicHandler(
  {
    contract: "patch",
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
            surface: "pages",
          }),
      ),
    );

    return Result.ok(response);
  },
);

const listStatuteSitemapShards = createSafeBoundedPublicHandler(
  {
    contract: "patch",
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
    contract: "patch",
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
export const publicLegislationRoute = routes(
  {
    "/statutes": { GET: listStatutes },
    "/statutes/search": { GET: searchPublicStatutes },
    "/statutes/shelf": { GET: readLegislationShelf },
    "/statutes/facets": { GET: readLegislationFacets },
    "/statutes/by-eli": { GET: readStatuteByEli },
    "/statutes/resolve": { POST: resolveStatutes },
    "/statutes/by-slug/:slug": { GET: readStatuteBySlug },
    "/statutes/:documentId": { GET: readStatute },
    "/statutes/:documentId/versions": { GET: listStatuteVersions },
    "/statutes/:documentId/provisions/:anchor/preview": {
      GET: readProvisionPreview,
    },
    "/statutes/:documentId/provisions/:anchor/history": {
      GET: readProvisionHistory,
    },
    "/sitemap/shards": { GET: listStatuteSitemapShards },
    "/sitemap/statutes/shard": { GET: listStatuteSitemapStatutes },
  },
  {
    prefix: "/law",
    middleware: [deploymentFeatureGate("FEATURE_PUBLIC_LAW")],
  },
);
