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
import fillTemplateById from "@/api/handlers/templates/fill-by-id";
import fillTemplatePreview from "@/api/handlers/templates/fill-preview";
import fillTemplate from "@/api/handlers/templates/fill";
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
  })
  .post("/fill", fillTemplate.handler, {
    body: fillTemplate.config.body,
    query: fillTemplate.config.query,
  })
  .post("/manifest", manifestTemplate.handler, {
    body: manifestTemplate.config.body,
  })
  // ── CRUD endpoints ─────────────────────────────────
  .get("/", listTemplates.handler, { query: listTemplates.config.query })
  .put("/", createTemplate.handler, {
    body: createTemplate.config.body,
  })
  .get("/:templateId/preview", previewTemplate.handler, {
    params: previewTemplate.config.params,
  })
  .post("/:templateId/fill-preview", fillTemplatePreview.handler, {
    params: fillTemplatePreview.config.params,
    body: fillTemplatePreview.config.body,
  })
  .post("/:templateId/fill", fillTemplateById.handler, {
    params: fillTemplateById.config.params,
    body: fillTemplateById.config.body,
    query: fillTemplateById.config.query,
  })
  .get("/:templateId", getTemplate.handler, {
    params: getTemplate.config.params,
  })
  .post("/:templateId", updateTemplate.handler, {
    params: updateTemplate.config.params,
    body: updateTemplate.config.body,
  })
  .delete("/:templateId", deleteTemplate.handler, {
    params: deleteTemplate.config.params,
  })
  // ── Versions ──────────────────────────────────────
  .get("/:templateId/versions", listTemplateVersions.handler, {
    params: listTemplateVersions.config.params,
  })
  .get("/:templateId/versions/:versionId", getTemplateVersion.handler, {
    params: getTemplateVersion.config.params,
  })
  // ── Clause linking ──────────────────────────────────
  .get("/:templateId/clauses", listTemplateClauses.handler, {
    params: listTemplateClauses.config.params,
  })
  .put("/:templateId/clauses", linkTemplateClause.handler, {
    params: linkTemplateClause.config.params,
    body: linkTemplateClause.config.body,
  })
  .delete("/:templateId/clauses/:linkId", unlinkTemplateClause.handler, {
    params: unlinkTemplateClause.config.params,
  })
  .post("/:templateId/clauses/:linkId/sync", syncTemplateClause.handler, {
    params: syncTemplateClause.config.params,
  });

// ── Template Categories ────────────────────────────

export const templateCategoriesRoute = new Elysia({
  prefix: "/template-categories",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listTemplateCategories.handler)
  .put("/", createTemplateCategory.handler, {
    body: createTemplateCategory.config.body,
  })
  .post("/:categoryId", updateTemplateCategory.handler, {
    params: updateTemplateCategory.config.params,
    body: updateTemplateCategory.config.body,
  })
  .delete("/:categoryId", deleteTemplateCategory.handler, {
    params: deleteTemplateCategory.config.params,
  });
