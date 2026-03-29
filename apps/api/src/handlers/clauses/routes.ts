import Elysia from "elysia";

import createClauseCategory from "@/api/handlers/clauses/categories-create";
import deleteClauseCategory from "@/api/handlers/clauses/categories-delete";
import listClauseCategories from "@/api/handlers/clauses/categories-list";
import updateClauseCategory from "@/api/handlers/clauses/categories-update";
import createClause from "@/api/handlers/clauses/create";
import deleteClause from "@/api/handlers/clauses/delete";
import exportClauses from "@/api/handlers/clauses/export";
import importClauses from "@/api/handlers/clauses/import";
import getClause from "@/api/handlers/clauses/read-by-id";
import listClauses from "@/api/handlers/clauses/read-list";
import getClauseVersion from "@/api/handlers/clauses/read-version";
import updateClause from "@/api/handlers/clauses/update";
import createVariant from "@/api/handlers/clauses/variants-create";
import deleteVariant from "@/api/handlers/clauses/variants-delete";
import listVariants from "@/api/handlers/clauses/variants-list";
import updateVariant from "@/api/handlers/clauses/variants-update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

// ── Categories ──────────────────────────────────────

export const clauseCategoriesRoute = new Elysia({
  prefix: "/clause-categories",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listClauseCategories.handler)
  .put("/", createClauseCategory.handler, {
    body: createClauseCategory.config.body,
  })
  .post("/:categoryId", updateClauseCategory.handler, {
    params: updateClauseCategory.config.params,
    body: updateClauseCategory.config.body,
  })
  .delete("/:categoryId", deleteClauseCategory.handler, {
    params: deleteClauseCategory.config.params,
  });

// ── Clauses ─────────────────────────────────────────

export const clausesRoute = new Elysia({
  prefix: "/clauses",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listClauses.handler, {
    query: listClauses.config.query,
  })
  .put("/", createClause.handler, {
    body: createClause.config.body,
  })
  .get("/export", exportClauses.handler, {
    query: exportClauses.config.query,
  })
  .put("/import", importClauses.handler, {
    body: importClauses.config.body,
  })
  .get("/:clauseId", getClause.handler, {
    params: getClause.config.params,
  })
  .post("/:clauseId", updateClause.handler, {
    params: updateClause.config.params,
    body: updateClause.config.body,
  })
  .delete("/:clauseId", deleteClause.handler, {
    params: deleteClause.config.params,
  })
  // ── Versions ───────────────────────────────────
  .get("/:clauseId/versions/:versionId", getClauseVersion.handler, {
    params: getClauseVersion.config.params,
  })
  // ── Variants ────────────────────────────────────
  .get("/:clauseId/variants", listVariants.handler, {
    params: listVariants.config.params,
  })
  .put("/:clauseId/variants", createVariant.handler, {
    params: createVariant.config.params,
    body: createVariant.config.body,
  })
  .post("/:clauseId/variants/:variantId", updateVariant.handler, {
    params: updateVariant.config.params,
    body: updateVariant.config.body,
  })
  .delete("/:clauseId/variants/:variantId", deleteVariant.handler, {
    params: deleteVariant.config.params,
  });
