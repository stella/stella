import Elysia from "elysia";

import createClauseCategory from "@/api/handlers/clauses/categories/create";
import deleteClauseCategory from "@/api/handlers/clauses/categories/delete";
import listClauseCategories from "@/api/handlers/clauses/categories/list";
import updateClauseCategory from "@/api/handlers/clauses/categories/update";
import createClause from "@/api/handlers/clauses/create";
import deleteClause from "@/api/handlers/clauses/delete";
import exportClauses from "@/api/handlers/clauses/export";
import getClause from "@/api/handlers/clauses/get";
import importClauses from "@/api/handlers/clauses/import";
import listClauses from "@/api/handlers/clauses/list";
import rewriteClause from "@/api/handlers/clauses/rewrite";
import getTemplateClausePreview from "@/api/handlers/clauses/template-slots/preview";
import updateClause from "@/api/handlers/clauses/update";
import createVariant from "@/api/handlers/clauses/variants/create";
import deleteVariant from "@/api/handlers/clauses/variants/delete";
import listVariants from "@/api/handlers/clauses/variants/list";
import updateVariant from "@/api/handlers/clauses/variants/update";
import clauseVersionDiff from "@/api/handlers/clauses/versions/diff";
import getClauseVersion from "@/api/handlers/clauses/versions/get";
import restoreClauseVersion from "@/api/handlers/clauses/versions/restore";
import clauseVersionSummarize from "@/api/handlers/clauses/versions/summarize";
import { authMacro, permissionMacro } from "@/api/lib/auth";

// ── Categories ──────────────────────────────────────

export const clauseCategoriesRoute = new Elysia({
  prefix: "/clause-categories",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      permissions: listClauseCategories.config.permissions,
    },
    listClauseCategories.handler,
  )
  .put(
    "/",
    {
      body: createClauseCategory.config.body,
      permissions: createClauseCategory.config.permissions,
    },
    createClauseCategory.handler,
  )
  .post(
    "/:categoryId",
    {
      body: updateClauseCategory.config.body,
      params: updateClauseCategory.config.params,
      permissions: updateClauseCategory.config.permissions,
    },
    updateClauseCategory.handler,
  )
  .delete(
    "/:categoryId",
    {
      params: deleteClauseCategory.config.params,
      permissions: deleteClauseCategory.config.permissions,
    },
    deleteClauseCategory.handler,
  );

// ── Clauses ─────────────────────────────────────────

export const clausesRoute = new Elysia({
  prefix: "/clauses",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      permissions: listClauses.config.permissions,
      query: listClauses.config.query,
    },
    listClauses.handler,
  )
  .put(
    "/",
    {
      body: createClause.config.body,
      permissions: createClause.config.permissions,
    },
    createClause.handler,
  )
  .get(
    "/export",
    {
      permissions: exportClauses.config.permissions,
      query: exportClauses.config.query,
    },
    exportClauses.handler,
  )
  // Deprecated compatibility alias for clients using the original JSON import.
  .put(
    "/import",
    {
      body: importClauses.config.body,
      permissions: importClauses.config.permissions,
    },
    importClauses.handler,
  )
  .post(
    "/import",
    {
      body: importClauses.config.body,
      permissions: importClauses.config.permissions,
    },
    importClauses.handler,
  )
  // AI assist: revise a clause body's prose in place (stateless; static path
  // registered before /:clauseId so it isn't captured as an id).
  .post(
    "/ai-rewrite",
    {
      body: rewriteClause.config.body,
      permissions: rewriteClause.config.permissions,
    },
    rewriteClause.handler,
  )
  // Live fill preview: resolve a template's linked clause slots to plain text.
  .get(
    "/template-slot-preview/:templateId",
    {
      params: getTemplateClausePreview.config.params,
      permissions: getTemplateClausePreview.config.permissions,
    },
    getTemplateClausePreview.handler,
  )
  .get(
    "/:clauseId",
    {
      params: getClause.config.params,
      permissions: getClause.config.permissions,
    },
    getClause.handler,
  )
  .post(
    "/:clauseId",
    {
      body: updateClause.config.body,
      params: updateClause.config.params,
      permissions: updateClause.config.permissions,
    },
    updateClause.handler,
  )
  .delete(
    "/:clauseId",
    {
      params: deleteClause.config.params,
      permissions: deleteClause.config.permissions,
    },
    deleteClause.handler,
  )
  // ── Versions ───────────────────────────────────
  .get(
    "/:clauseId/versions/:versionId",
    {
      params: getClauseVersion.config.params,
      permissions: getClauseVersion.config.permissions,
    },
    getClauseVersion.handler,
  )
  .get(
    "/:clauseId/versions/:versionId/diff",
    {
      params: clauseVersionDiff.config.params,
      permissions: clauseVersionDiff.config.permissions,
    },
    clauseVersionDiff.handler,
  )
  .post(
    "/:clauseId/versions/:versionId/summarize",
    {
      params: clauseVersionSummarize.config.params,
      permissions: clauseVersionSummarize.config.permissions,
    },
    clauseVersionSummarize.handler,
  )
  .post(
    "/:clauseId/versions/:versionId/restore",
    {
      params: restoreClauseVersion.config.params,
      permissions: restoreClauseVersion.config.permissions,
    },
    restoreClauseVersion.handler,
  )
  // ── Variants ────────────────────────────────────
  .get(
    "/:clauseId/variants",
    {
      params: listVariants.config.params,
      permissions: listVariants.config.permissions,
    },
    listVariants.handler,
  )
  .put(
    "/:clauseId/variants",
    {
      body: createVariant.config.body,
      params: createVariant.config.params,
      permissions: createVariant.config.permissions,
    },
    createVariant.handler,
  )
  .post(
    "/:clauseId/variants/:variantId",
    {
      body: updateVariant.config.body,
      params: updateVariant.config.params,
      permissions: updateVariant.config.permissions,
    },
    updateVariant.handler,
  )
  .delete(
    "/:clauseId/variants/:variantId",
    {
      params: deleteVariant.config.params,
      permissions: deleteVariant.config.permissions,
    },
    deleteVariant.handler,
  );
