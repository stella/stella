import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { readLegislationHandler } from "@/api/handlers/legislation/read-by-id";
import {
  searchLegislationBodySchema,
  searchLegislationHandler,
} from "@/api/handlers/legislation/search";
import {
  createSafeRootHandler,
  type HandlerConfig,
} from "@/api/lib/api-handlers";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { tSafeId } from "@/api/lib/custom-schema";

/**
 * Corpus-legislation routes (ingested statutes searchable via the
 * corpus index/pg-fts substrate). Namespaced under /legislation/corpus to
 * avoid colliding with the existing BOE proxy routes in routes.ts.
 */

const searchLegislation = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    body: searchLegislationBodySchema,
  } satisfies HandlerConfig,
  async function* ({ body, scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await searchLegislationHandler(body, scopedDb),
      ),
    );
    return Result.ok(response);
  },
);

const readLegislation = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    params: t.Object({ documentId: tSafeId("legislationDocument") }),
  } satisfies HandlerConfig,
  async function* ({ params: { documentId }, scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await readLegislationHandler(documentId, scopedDb),
      ),
    );
    return Result.ok(response);
  },
);

export const legislationCorpusRoute = new Elysia({
  prefix: "/legislation/corpus",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/search", searchLegislation.handler, {
    body: searchLegislation.config.body,
    permissions: searchLegislation.config.permissions,
  })
  .get("/:documentId", readLegislation.handler, {
    params: readLegislation.config.params,
    permissions: readLegislation.config.permissions,
  });
