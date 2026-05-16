import Elysia from "elysia";

import createTemplateCategory from "@/api/handlers/templates/categories-create";
import deleteTemplateCategory from "@/api/handlers/templates/categories-delete";
import listTemplateCategories from "@/api/handlers/templates/categories-list";
import updateTemplateCategory from "@/api/handlers/templates/categories-update";
import linkTemplateClause from "@/api/handlers/templates/clauses-link";
import listTemplateClauses from "@/api/handlers/templates/clauses-list";
import syncTemplateClause from "@/api/handlers/templates/clauses-sync";
import unlinkTemplateClause from "@/api/handlers/templates/clauses-unlink";
import createTemplate from "@/api/handlers/templates/create";
import deleteTemplate from "@/api/handlers/templates/delete";
import discoverTemplate from "@/api/handlers/templates/discover";
import fillTemplate from "@/api/handlers/templates/fill";
import fillTemplateById from "@/api/handlers/templates/fill-by-id";
import fillTemplatePreview from "@/api/handlers/templates/fill-preview";
import getTemplate from "@/api/handlers/templates/get";
import listTemplates from "@/api/handlers/templates/list";
import manifestTemplate from "@/api/handlers/templates/manifest";
import previewTemplate from "@/api/handlers/templates/preview";
import updateTemplate from "@/api/handlers/templates/update";
import getTemplateVersion from "@/api/handlers/templates/versions-get";
import listTemplateVersions from "@/api/handlers/templates/versions-list";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const templatesRoute = new Elysia({
  prefix: "/templates",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  // ── Existing transient endpoints ───────────────────
  .post("/discover", discoverTemplate.handler, {
    body: discoverTemplate.config.body,
    permissions: discoverTemplate.config.permissions,
  })
  .post("/fill", fillTemplate.handler, {
    body: fillTemplate.config.body,
    permissions: fillTemplate.config.permissions,
    query: fillTemplate.config.query,
  })
  .post("/manifest", manifestTemplate.handler, {
    body: manifestTemplate.config.body,
    permissions: manifestTemplate.config.permissions,
  })
  // ── CRUD endpoints ─────────────────────────────────
  .get("/", listTemplates.handler, {
    permissions: listTemplates.config.permissions,
    query: listTemplates.config.query,
  })
  .put("/", createTemplate.handler, {
    body: createTemplate.config.body,
    permissions: createTemplate.config.permissions,
  })
  .get("/:templateId/preview", previewTemplate.handler, {
    params: previewTemplate.config.params,
    permissions: previewTemplate.config.permissions,
  })
  .post("/:templateId/fill-preview", fillTemplatePreview.handler, {
    body: fillTemplatePreview.config.body,
    params: fillTemplatePreview.config.params,
    permissions: fillTemplatePreview.config.permissions,
  })
  .post("/:templateId/fill", fillTemplateById.handler, {
    body: fillTemplateById.config.body,
    params: fillTemplateById.config.params,
    permissions: fillTemplateById.config.permissions,
    query: fillTemplateById.config.query,
  })
  .get("/:templateId", getTemplate.handler, {
    params: getTemplate.config.params,
    permissions: getTemplate.config.permissions,
  })
  .post("/:templateId", updateTemplate.handler, {
    body: updateTemplate.config.body,
    params: updateTemplate.config.params,
    permissions: updateTemplate.config.permissions,
  })
  .delete("/:templateId", deleteTemplate.handler, {
    params: deleteTemplate.config.params,
    permissions: deleteTemplate.config.permissions,
  })
  // ── Versions ──────────────────────────────────────
  .get("/:templateId/versions", listTemplateVersions.handler, {
    params: listTemplateVersions.config.params,
    permissions: listTemplateVersions.config.permissions,
  })
  .get("/:templateId/versions/:versionId", getTemplateVersion.handler, {
    params: getTemplateVersion.config.params,
    permissions: getTemplateVersion.config.permissions,
  })
  // ── Clause linking ──────────────────────────────────
  .get("/:templateId/clauses", listTemplateClauses.handler, {
    params: listTemplateClauses.config.params,
    permissions: listTemplateClauses.config.permissions,
  })
  .put("/:templateId/clauses", linkTemplateClause.handler, {
    body: linkTemplateClause.config.body,
    params: linkTemplateClause.config.params,
    permissions: linkTemplateClause.config.permissions,
  })
  .delete("/:templateId/clauses/:linkId", unlinkTemplateClause.handler, {
    params: unlinkTemplateClause.config.params,
    permissions: unlinkTemplateClause.config.permissions,
  })
  .post("/:templateId/clauses/:linkId/sync", syncTemplateClause.handler, {
    params: syncTemplateClause.config.params,
    permissions: syncTemplateClause.config.permissions,
  });

// ── Template Categories ────────────────────────────

export const templateCategoriesRoute = new Elysia({
  prefix: "/template-categories",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listTemplateCategories.handler, {
    permissions: listTemplateCategories.config.permissions,
  })
  .put("/", createTemplateCategory.handler, {
    body: createTemplateCategory.config.body,
    permissions: createTemplateCategory.config.permissions,
  })
  .post("/:categoryId", updateTemplateCategory.handler, {
    body: updateTemplateCategory.config.body,
    params: updateTemplateCategory.config.params,
    permissions: updateTemplateCategory.config.permissions,
  })
  .delete("/:categoryId", deleteTemplateCategory.handler, {
    params: deleteTemplateCategory.config.params,
    permissions: deleteTemplateCategory.config.permissions,
  });
