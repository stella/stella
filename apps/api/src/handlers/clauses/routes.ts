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
  .get("/", listClauseCategories.handler, {
    permissions: listClauseCategories.config.permissions,
    accountAccess: listClauseCategories.config.accountAccess,
  })
  .put("/", createClauseCategory.handler, {
    body: createClauseCategory.config.body,
    permissions: createClauseCategory.config.permissions,
    accountAccess: createClauseCategory.config.accountAccess,
  })
  .post("/:categoryId", updateClauseCategory.handler, {
    body: updateClauseCategory.config.body,
    params: updateClauseCategory.config.params,
    permissions: updateClauseCategory.config.permissions,
    accountAccess: updateClauseCategory.config.accountAccess,
  })
  .delete("/:categoryId", deleteClauseCategory.handler, {
    params: deleteClauseCategory.config.params,
    permissions: deleteClauseCategory.config.permissions,
    accountAccess: deleteClauseCategory.config.accountAccess,
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
    accountAccess: listClauses.config.accountAccess,
    query: listClauses.config.query,
  })
  .put("/", createClause.handler, {
    body: createClause.config.body,
    permissions: createClause.config.permissions,
    accountAccess: createClause.config.accountAccess,
  })
  .get("/export", exportClauses.handler, {
    permissions: exportClauses.config.permissions,
    accountAccess: exportClauses.config.accountAccess,
    query: exportClauses.config.query,
  })
  // Deprecated compatibility alias for clients using the original JSON import.
  .put("/import", importClauses.handler, {
    body: importClauses.config.body,
    permissions: importClauses.config.permissions,
    accountAccess: importClauses.config.accountAccess,
  })
  .post("/import", importClauses.handler, {
    body: importClauses.config.body,
    permissions: importClauses.config.permissions,
    accountAccess: importClauses.config.accountAccess,
  })
  // AI assist: revise a clause body's prose in place (stateless; static path
  // registered before /:clauseId so it isn't captured as an id).
  .post("/ai-rewrite", rewriteClause.handler, {
    body: rewriteClause.config.body,
    permissions: rewriteClause.config.permissions,
    accountAccess: rewriteClause.config.accountAccess,
  })
  // Live fill preview: resolve a template's linked clause slots to plain text.
  .get("/template-slot-preview/:templateId", getTemplateClausePreview.handler, {
    params: getTemplateClausePreview.config.params,
    permissions: getTemplateClausePreview.config.permissions,
    accountAccess: getTemplateClausePreview.config.accountAccess,
  })
  .get("/:clauseId", getClause.handler, {
    params: getClause.config.params,
    permissions: getClause.config.permissions,
    accountAccess: getClause.config.accountAccess,
  })
  .post("/:clauseId", updateClause.handler, {
    body: updateClause.config.body,
    params: updateClause.config.params,
    permissions: updateClause.config.permissions,
    accountAccess: updateClause.config.accountAccess,
  })
  .delete("/:clauseId", deleteClause.handler, {
    params: deleteClause.config.params,
    permissions: deleteClause.config.permissions,
    accountAccess: deleteClause.config.accountAccess,
  })
  // ── Versions ───────────────────────────────────
  .get("/:clauseId/versions/:versionId", getClauseVersion.handler, {
    params: getClauseVersion.config.params,
    permissions: getClauseVersion.config.permissions,
    accountAccess: getClauseVersion.config.accountAccess,
  })
  .get("/:clauseId/versions/:versionId/diff", clauseVersionDiff.handler, {
    params: clauseVersionDiff.config.params,
    permissions: clauseVersionDiff.config.permissions,
    accountAccess: clauseVersionDiff.config.accountAccess,
  })
  .post(
    "/:clauseId/versions/:versionId/summarize",
    clauseVersionSummarize.handler,
    {
      params: clauseVersionSummarize.config.params,
      permissions: clauseVersionSummarize.config.permissions,
      accountAccess: clauseVersionSummarize.config.accountAccess,
    },
  )
  .post(
    "/:clauseId/versions/:versionId/restore",
    restoreClauseVersion.handler,
    {
      body: restoreClauseVersion.config.body,
      params: restoreClauseVersion.config.params,
      permissions: restoreClauseVersion.config.permissions,
      accountAccess: restoreClauseVersion.config.accountAccess,
    },
  )
  // ── Variants ────────────────────────────────────
  .get("/:clauseId/variants", listVariants.handler, {
    params: listVariants.config.params,
    permissions: listVariants.config.permissions,
    accountAccess: listVariants.config.accountAccess,
  })
  .put("/:clauseId/variants", createVariant.handler, {
    body: createVariant.config.body,
    params: createVariant.config.params,
    permissions: createVariant.config.permissions,
    accountAccess: createVariant.config.accountAccess,
  })
  .post("/:clauseId/variants/:variantId", updateVariant.handler, {
    body: updateVariant.config.body,
    params: updateVariant.config.params,
    permissions: updateVariant.config.permissions,
    accountAccess: updateVariant.config.accountAccess,
  })
  .delete("/:clauseId/variants/:variantId", deleteVariant.handler, {
    params: deleteVariant.config.params,
    permissions: deleteVariant.config.permissions,
    accountAccess: deleteVariant.config.accountAccess,
  });
