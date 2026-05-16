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
  .get("/", listClauseCategories.handler, {
    permissions: listClauseCategories.config.permissions,
  })
  .put("/", createClauseCategory.handler, {
    body: createClauseCategory.config.body,
    permissions: createClauseCategory.config.permissions,
  })
  .post("/:categoryId", updateClauseCategory.handler, {
    body: updateClauseCategory.config.body,
    params: updateClauseCategory.config.params,
    permissions: updateClauseCategory.config.permissions,
  })
  .delete("/:categoryId", deleteClauseCategory.handler, {
    params: deleteClauseCategory.config.params,
    permissions: deleteClauseCategory.config.permissions,
  });

// ── Clauses ─────────────────────────────────────────

export const clausesRoute = new Elysia({
  prefix: "/clauses",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listClauses.handler, {
    permissions: listClauses.config.permissions,
    query: listClauses.config.query,
  })
  .put("/", createClause.handler, {
    body: createClause.config.body,
    permissions: createClause.config.permissions,
  })
  .get("/export", exportClauses.handler, {
    permissions: exportClauses.config.permissions,
    query: exportClauses.config.query,
  })
  .put("/import", importClauses.handler, {
    body: importClauses.config.body,
    permissions: importClauses.config.permissions,
  })
  .get("/:clauseId", getClause.handler, {
    params: getClause.config.params,
    permissions: getClause.config.permissions,
  })
  .post("/:clauseId", updateClause.handler, {
    body: updateClause.config.body,
    params: updateClause.config.params,
    permissions: updateClause.config.permissions,
  })
  .delete("/:clauseId", deleteClause.handler, {
    params: deleteClause.config.params,
    permissions: deleteClause.config.permissions,
  })
  // ── Versions ───────────────────────────────────
  .get("/:clauseId/versions/:versionId", getClauseVersion.handler, {
    params: getClauseVersion.config.params,
    permissions: getClauseVersion.config.permissions,
  })
  // ── Variants ────────────────────────────────────
  .get("/:clauseId/variants", listVariants.handler, {
    params: listVariants.config.params,
    permissions: listVariants.config.permissions,
  })
  .put("/:clauseId/variants", createVariant.handler, {
    body: createVariant.config.body,
    params: createVariant.config.params,
    permissions: createVariant.config.permissions,
  })
  .post("/:clauseId/variants/:variantId", updateVariant.handler, {
    body: updateVariant.config.body,
    params: updateVariant.config.params,
    permissions: updateVariant.config.permissions,
  })
  .delete("/:clauseId/variants/:variantId", deleteVariant.handler, {
    params: deleteVariant.config.params,
    permissions: deleteVariant.config.permissions,
  });
