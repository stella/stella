import Elysia from "elysia";

import getBindingCatalog from "@/api/handlers/templates/bindings/list";
import createBlankTemplate from "@/api/handlers/templates/blank/create";
import createTemplateCategory from "@/api/handlers/templates/categories/create";
import deleteTemplateCategory from "@/api/handlers/templates/categories/delete";
import listTemplateCategories from "@/api/handlers/templates/categories/list";
import updateTemplateCategory from "@/api/handlers/templates/categories/update";
import checkTemplate from "@/api/handlers/templates/check";
import getTemplateClauseSlots from "@/api/handlers/templates/clause-slots/list";
import updateTemplateClauseSlot from "@/api/handlers/templates/clause-slots/update";
import linkTemplateClause from "@/api/handlers/templates/clauses/link";
import listTemplateClauses from "@/api/handlers/templates/clauses/list";
import syncTemplateClause from "@/api/handlers/templates/clauses/sync";
import unlinkTemplateClause from "@/api/handlers/templates/clauses/unlink";
import decideTemplateConditions from "@/api/handlers/templates/condition-decisions/get";
import createTemplate from "@/api/handlers/templates/create";
import deleteTemplate from "@/api/handlers/templates/delete";
import discoverTemplate from "@/api/handlers/templates/discover";
import saveTemplateDocument from "@/api/handlers/templates/document/update";
import suggestFields from "@/api/handlers/templates/fields/suggest";
import fillTemplate from "@/api/handlers/templates/fill";
import fillTemplateToWorkspace from "@/api/handlers/templates/fills/create";
import fillTemplateById from "@/api/handlers/templates/fills/download";
import fillTemplatePreview from "@/api/handlers/templates/fills/preview";
import createTemplateFromStyleSet from "@/api/handlers/templates/from-style-set/create";
import createTemplateFromStyles from "@/api/handlers/templates/from-styles/create";
import getTemplate from "@/api/handlers/templates/get";
import listTemplates from "@/api/handlers/templates/list";
import createLookupFormat from "@/api/handlers/templates/lookup-formats/create";
import setDefaultLookupFormat from "@/api/handlers/templates/lookup-formats/default/update";
import deleteLookupFormat from "@/api/handlers/templates/lookup-formats/delete";
import listLookupFormats from "@/api/handlers/templates/lookup-formats/list";
import setMyDefaultLookupFormat from "@/api/handlers/templates/lookup-formats/my-default/update";
import lookupPreview from "@/api/handlers/templates/lookups/preview";
import syncAllTemplateClauses from "@/api/handlers/templates/outdated-clauses/sync";
import prefillTemplate from "@/api/handlers/templates/prefill";
import prepareTemplate from "@/api/handlers/templates/prepare";
import previewTemplate from "@/api/handlers/templates/preview";
import updateTemplate from "@/api/handlers/templates/update";
import templateVersionDiff from "@/api/handlers/templates/versions/diff";
import getTemplateVersion from "@/api/handlers/templates/versions/get";
import listTemplateVersions from "@/api/handlers/templates/versions/list";
import templateVersionSummarize from "@/api/handlers/templates/versions/summarize";
import {
  authMacro,
  permissionMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";

export const templatesRoute = new Elysia({
  prefix: "/templates",
})
  .use(authMacro)
  .use(permissionMacro)
  .use(workspaceAccessMacro)
  .guard({
    validateAuth: true,
  })
  // ── Existing transient endpoints ───────────────────
  .get(
    "/lookup-formats",
    {
      query: listLookupFormats.config.query,
      permissions: listLookupFormats.config.permissions,
    },
    listLookupFormats.handler,
  )
  .post(
    "/lookup-formats",
    {
      body: createLookupFormat.config.body,
      permissions: createLookupFormat.config.permissions,
    },
    createLookupFormat.handler,
  )
  .delete(
    "/lookup-formats/:formatId",
    {
      params: deleteLookupFormat.config.params,
      permissions: deleteLookupFormat.config.permissions,
    },
    deleteLookupFormat.handler,
  )
  .post(
    "/lookup-formats/default",
    {
      body: setDefaultLookupFormat.config.body,
      permissions: setDefaultLookupFormat.config.permissions,
    },
    setDefaultLookupFormat.handler,
  )
  .post(
    "/lookup-formats/my-default",
    {
      body: setMyDefaultLookupFormat.config.body,
      permissions: setMyDefaultLookupFormat.config.permissions,
    },
    setMyDefaultLookupFormat.handler,
  )
  .post(
    "/discover",
    {
      body: discoverTemplate.config.body,
      permissions: discoverTemplate.config.permissions,
    },
    discoverTemplate.handler,
  )
  .post(
    "/fill",
    {
      body: fillTemplate.config.body,
      permissions: fillTemplate.config.permissions,
      query: fillTemplate.config.query,
    },
    fillTemplate.handler,
  )
  .post(
    "/lookup-preview",
    {
      body: lookupPreview.config.body,
      permissions: lookupPreview.config.permissions,
    },
    lookupPreview.handler,
  )
  .post(
    "/prepare",
    {
      body: prepareTemplate.config.body,
      permissions: prepareTemplate.config.permissions,
    },
    prepareTemplate.handler,
  )
  .post(
    "/suggest-fields",
    {
      body: suggestFields.config.body,
      permissions: suggestFields.config.permissions,
    },
    suggestFields.handler,
  )
  // Static catalog of data-binding (source, field) options; placed among the
  // transient GET endpoints, before `/:templateId` so the literal path wins.
  .get(
    "/binding-catalog",
    {
      permissions: getBindingCatalog.config.permissions,
    },
    getBindingCatalog.handler,
  )
  // ── CRUD endpoints ─────────────────────────────────
  .get(
    "/",
    {
      permissions: listTemplates.config.permissions,
      query: listTemplates.config.query,
    },
    listTemplates.handler,
  )
  .put(
    "/",
    {
      body: createTemplate.config.body,
      permissions: createTemplate.config.permissions,
    },
    createTemplate.handler,
  )
  .put(
    "/blank",
    {
      body: createBlankTemplate.config.body,
      permissions: createBlankTemplate.config.permissions,
    },
    createBlankTemplate.handler,
  )
  .put(
    "/styles",
    {
      body: createTemplateFromStyles.config.body,
      permissions: createTemplateFromStyles.config.permissions,
    },
    createTemplateFromStyles.handler,
  )
  .put(
    "/style-set",
    {
      body: createTemplateFromStyleSet.config.body,
      permissions: createTemplateFromStyleSet.config.permissions,
    },
    createTemplateFromStyleSet.handler,
  )
  .get(
    "/:templateId/preview",
    {
      params: previewTemplate.config.params,
      permissions: previewTemplate.config.permissions,
    },
    previewTemplate.handler,
  )
  .get(
    "/:templateId/check",
    {
      params: checkTemplate.config.params,
      permissions: checkTemplate.config.permissions,
    },
    checkTemplate.handler,
  )
  .post(
    "/:templateId/decide-conditions",
    {
      body: decideTemplateConditions.config.body,
      params: decideTemplateConditions.config.params,
      permissions: decideTemplateConditions.config.permissions,
    },
    decideTemplateConditions.handler,
  )
  .post(
    "/:templateId/fill-preview",
    {
      body: fillTemplatePreview.config.body,
      params: fillTemplatePreview.config.params,
      permissions: fillTemplatePreview.config.permissions,
    },
    fillTemplatePreview.handler,
  )
  .post(
    "/:templateId/fill",
    {
      body: fillTemplateById.config.body,
      params: fillTemplateById.config.params,
      permissions: fillTemplateById.config.permissions,
      query: fillTemplateById.config.query,
    },
    fillTemplateById.handler,
  )
  .post(
    "/:templateId/fill-to/:workspaceId",
    {
      body: fillTemplateToWorkspace.config.body,
      params: fillTemplateToWorkspace.config.params,
      permissions: fillTemplateToWorkspace.config.permissions,
      validateWorkspaceAccess: true,
    },
    fillTemplateToWorkspace.handler,
  )
  .post(
    "/:templateId/prefill",
    {
      body: prefillTemplate.config.body,
      params: prefillTemplate.config.params,
      permissions: prefillTemplate.config.permissions,
    },
    prefillTemplate.handler,
  )
  .get(
    "/:templateId",
    {
      params: getTemplate.config.params,
      permissions: getTemplate.config.permissions,
    },
    getTemplate.handler,
  )
  .get(
    "/:templateId/clause-slots",
    {
      params: getTemplateClauseSlots.config.params,
      permissions: getTemplateClauseSlots.config.permissions,
    },
    getTemplateClauseSlots.handler,
  )
  .post(
    "/:templateId",
    {
      body: updateTemplate.config.body,
      params: updateTemplate.config.params,
      permissions: updateTemplate.config.permissions,
    },
    updateTemplate.handler,
  )
  .post(
    "/:templateId/document",
    {
      body: saveTemplateDocument.config.body,
      params: saveTemplateDocument.config.params,
      permissions: saveTemplateDocument.config.permissions,
    },
    saveTemplateDocument.handler,
  )
  .delete(
    "/:templateId",
    {
      params: deleteTemplate.config.params,
      permissions: deleteTemplate.config.permissions,
    },
    deleteTemplate.handler,
  )
  // ── Versions ──────────────────────────────────────
  .get(
    "/:templateId/versions",
    {
      params: listTemplateVersions.config.params,
      permissions: listTemplateVersions.config.permissions,
      query: listTemplateVersions.config.query,
    },
    listTemplateVersions.handler,
  )
  .get(
    "/:templateId/versions/:versionId",
    {
      params: getTemplateVersion.config.params,
      permissions: getTemplateVersion.config.permissions,
    },
    getTemplateVersion.handler,
  )
  .get(
    "/:templateId/versions/:versionId/diff",
    {
      params: templateVersionDiff.config.params,
      permissions: templateVersionDiff.config.permissions,
    },
    templateVersionDiff.handler,
  )
  .post(
    "/:templateId/versions/:versionId/summarize",
    {
      params: templateVersionSummarize.config.params,
      permissions: templateVersionSummarize.config.permissions,
    },
    templateVersionSummarize.handler,
  )
  // ── Clause linking ──────────────────────────────────
  .get(
    "/:templateId/clauses",
    {
      params: listTemplateClauses.config.params,
      permissions: listTemplateClauses.config.permissions,
    },
    listTemplateClauses.handler,
  )
  .put(
    "/:templateId/clauses",
    {
      body: linkTemplateClause.config.body,
      params: linkTemplateClause.config.params,
      permissions: linkTemplateClause.config.permissions,
    },
    linkTemplateClause.handler,
  )
  .patch(
    "/:templateId/clauses/:linkId",
    {
      body: updateTemplateClauseSlot.config.body,
      params: updateTemplateClauseSlot.config.params,
      permissions: updateTemplateClauseSlot.config.permissions,
    },
    updateTemplateClauseSlot.handler,
  )
  .delete(
    "/:templateId/clauses/:linkId",
    {
      params: unlinkTemplateClause.config.params,
      permissions: unlinkTemplateClause.config.permissions,
    },
    unlinkTemplateClause.handler,
  )
  .post(
    "/:templateId/clauses/sync",
    {
      params: syncAllTemplateClauses.config.params,
      permissions: syncAllTemplateClauses.config.permissions,
    },
    syncAllTemplateClauses.handler,
  )
  .post(
    "/:templateId/clauses/:linkId/sync",
    {
      params: syncTemplateClause.config.params,
      permissions: syncTemplateClause.config.permissions,
    },
    syncTemplateClause.handler,
  );

// ── Template Categories ────────────────────────────

export const templateCategoriesRoute = new Elysia({
  prefix: "/template-categories",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      permissions: listTemplateCategories.config.permissions,
    },
    listTemplateCategories.handler,
  )
  .put(
    "/",
    {
      body: createTemplateCategory.config.body,
      permissions: createTemplateCategory.config.permissions,
    },
    createTemplateCategory.handler,
  )
  .post(
    "/:categoryId",
    {
      body: updateTemplateCategory.config.body,
      params: updateTemplateCategory.config.params,
      permissions: updateTemplateCategory.config.permissions,
    },
    updateTemplateCategory.handler,
  )
  .delete(
    "/:categoryId",
    {
      params: deleteTemplateCategory.config.params,
      permissions: deleteTemplateCategory.config.permissions,
    },
    deleteTemplateCategory.handler,
  );
