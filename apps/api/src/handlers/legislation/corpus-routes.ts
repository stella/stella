import Elysia from "elysia";

import readLegislation from "@/api/handlers/legislation/read-by-id";
import searchLegislation from "@/api/handlers/legislation/search";
import { authMacro, permissionMacro } from "@/api/lib/auth";

/**
 * Corpus-legislation routes (ingested statutes searchable via the
 * corpus index/pg-fts substrate). Namespaced under /legislation/corpus to
 * avoid colliding with the existing BOE proxy routes in routes.ts.
 */

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
