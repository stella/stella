import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { env } from "@/api/env";
import { readLegislationHandler } from "@/api/handlers/legislation/get";
import {
  listStatutesHandler,
  listStatutesQuerySchema,
} from "@/api/handlers/legislation/list";
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

const readStatute = createSafePublicHandler(
  {
    mcp: { type: "internal", reason: "public_indexing" },
    params: t.Object({ documentId: tSafeId("legislationDocument") }),
  },
  async function* ({ params: { documentId } }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readLegislationHandler(documentId, legislationPublicReadDb),
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
  .get("/statutes/:documentId", readStatute.handler, {
    params: readStatute.config.params,
  })
  .get("/statutes/:documentId/versions", listStatuteVersions.handler, {
    params: listStatuteVersions.config.params,
    query: listStatuteVersions.config.query,
  });
