import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { env } from "@/api/env";
import { listDecisionFacetsHandler } from "@/api/handlers/case-law/decisions/facets";
import {
  listDecisionsHandler,
  listDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/list";
import {
  readDecisionBySlugHandler,
  readDecisionHandler,
} from "@/api/handlers/case-law/decisions/read-by-id";
import {
  searchDecisionsBodySchema,
  searchDecisionsHandler,
} from "@/api/handlers/case-law/decisions/search";
import {
  listSitemapShardDecisionsHandler,
  listSitemapShardsHandler,
  sitemapShardDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/sitemap";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";

const listDecisions = createSafePublicHandler(
  {
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

const listDecisionFacets = createSafePublicHandler({}, async function* () {
  const response = yield* Result.await(
    Result.tryPromise(
      async () => await listDecisionFacetsHandler(caseLawPublicReadDb),
    ),
  );

  return Result.ok(response);
});

const readDecision = createSafePublicHandler(
  {
    params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
  },
  async function* ({ params: { decisionId } }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await readDecisionHandler(decisionId, caseLawPublicReadDb),
      ),
    );

    return Result.ok(response);
  },
);

const readDecisionBySlug = createSafePublicHandler(
  {
    params: t.Object({ slug: t.String({ minLength: 1, maxLength: 256 }) }),
    query: t.Object({
      language: t.Optional(t.String({ minLength: 2, maxLength: 8 })),
    }),
  },
  async function* ({ params: { slug }, query: { language } }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readDecisionBySlugHandler(slug, caseLawPublicReadDb, language),
      ),
    );

    return Result.ok(response);
  },
);

const searchDecisions = createSafePublicHandler(
  {
    body: searchDecisionsBodySchema,
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

const listSitemapShards = createSafePublicHandler({}, async function* () {
  const response = yield* Result.await(
    Result.tryPromise(
      async () => await listSitemapShardsHandler(caseLawPublicReadDb),
    ),
  );

  return Result.ok(response);
});

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
  .get("/decisions/facets", listDecisionFacets.handler)
  .get("/decisions/by-slug/:slug", readDecisionBySlug.handler, {
    params: readDecisionBySlug.config.params,
    query: readDecisionBySlug.config.query,
  })
  .get("/decisions/:decisionId", readDecision.handler, {
    params: readDecision.config.params,
  })
  .post("/decisions/search", searchDecisions.handler, {
    body: searchDecisions.config.body,
  })
  .get("/sitemap/shards", listSitemapShards.handler)
  .get("/sitemap/decisions/shard", listSitemapShardDecisions.handler, {
    query: listSitemapShardDecisions.config.query,
  });
