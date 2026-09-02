import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { env } from "@/api/env";
import {
  readStatuteByEliHandler,
  readStatuteByEliQuerySchema,
} from "@/api/handlers/legislation/by-eli";
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
import {
  legislationShelfQuerySchema,
  readLegislationShelfHandler,
} from "@/api/handlers/legislation/shelf";
import {
  listStatuteVersionsHandler,
  listStatuteVersionsParamsSchema,
  listStatuteVersionsQuerySchema,
} from "@/api/handlers/legislation/versions";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

const listStatutes = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
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

const readLegislationShelf = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
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

const readStatuteByEli = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
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

const readStatute = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
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

const listStatuteVersions = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
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

const readProvisionHistory = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
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

/**
 * Public-read routes: no auth, no session, no organization context.
 * Only sources cleared for redistribution are readable.
 */
export const publicLegislationRoute = new Elysia({
  prefix: "/law",
})
  .onBeforeHandle(({ set }) => {
    if (env.isDev || env.FEATURE_PUBLIC_LAW) {
      return undefined;
    }

    set.status = 404;
    return { error: "Not Found" } as const;
  })
  .get("/statutes", listStatutes.handler, {
    query: listStatutes.config.query,
  })
  // Ahead of `/statutes/:documentId` for the same reason as `by-eli` below.
  .get("/statutes/shelf", readLegislationShelf.handler, {
    query: readLegislationShelf.config.query,
  })
  // Ahead of `/statutes/:documentId`, or the literal segment would be read as
  // a document id and rejected by the UUID schema.
  .get("/statutes/by-eli", readStatuteByEli.handler, {
    query: readStatuteByEli.config.query,
  })
  .get("/statutes/:documentId", readStatute.handler, {
    params: readStatute.config.params,
  })
  .get("/statutes/:documentId/versions", listStatuteVersions.handler, {
    params: listStatuteVersions.config.params,
    query: listStatuteVersions.config.query,
  })
  .get(
    "/statutes/:documentId/provisions/:anchor/history",
    readProvisionHistory.handler,
    {
      params: readProvisionHistory.config.params,
      query: readProvisionHistory.config.query,
    },
  );
