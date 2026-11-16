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
import { routes } from "@/api/http/route";

export const templatesRoute = routes(
  {
    "/lookup-formats": { GET: listLookupFormats, POST: createLookupFormat },
    "/lookup-formats/:formatId": { DELETE: deleteLookupFormat },
    "/lookup-formats/default": { POST: setDefaultLookupFormat },
    "/lookup-formats/my-default": { POST: setMyDefaultLookupFormat },
    "/discover": { POST: discoverTemplate },
    "/fill": { POST: fillTemplate },
    "/lookup-preview": { POST: lookupPreview },
    "/prepare": { POST: prepareTemplate },
    "/suggest-fields": { POST: suggestFields },
    "/binding-catalog": { GET: getBindingCatalog },
    "/": { GET: listTemplates, PUT: createTemplate },
    "/blank": { PUT: createBlankTemplate },
    "/styles": { PUT: createTemplateFromStyles },
    "/style-set": { PUT: createTemplateFromStyleSet },
    "/:templateId/preview": { GET: previewTemplate },
    "/:templateId/check": { GET: checkTemplate },
    "/:templateId/decide-conditions": { POST: decideTemplateConditions },
    "/:templateId/fill-preview": { POST: fillTemplatePreview },
    "/:templateId/fill": { POST: fillTemplateById },
    "/:templateId/fill-to/:workspaceId": { POST: fillTemplateToWorkspace },
    "/:templateId/prefill": { POST: prefillTemplate },
    "/:templateId": {
      GET: getTemplate,
      POST: updateTemplate,
      DELETE: deleteTemplate,
    },
    "/:templateId/clause-slots": { GET: getTemplateClauseSlots },
    "/:templateId/document": { POST: saveTemplateDocument },
    "/:templateId/versions": { GET: listTemplateVersions },
    "/:templateId/versions/:versionId": { GET: getTemplateVersion },
    "/:templateId/versions/:versionId/diff": { GET: templateVersionDiff },
    "/:templateId/versions/:versionId/summarize": {
      POST: templateVersionSummarize,
    },
    "/:templateId/clauses": {
      GET: listTemplateClauses,
      PUT: linkTemplateClause,
    },
    "/:templateId/clauses/:linkId": {
      PATCH: updateTemplateClauseSlot,
      DELETE: unlinkTemplateClause,
    },
    "/:templateId/clauses/sync": { POST: syncAllTemplateClauses },
    "/:templateId/clauses/:linkId/sync": { POST: syncTemplateClause },
  },
  { prefix: "/templates" },
);

// ── Template Categories ────────────────────────────

export const templateCategoriesRoute = routes(
  {
    "/": { GET: listTemplateCategories, PUT: createTemplateCategory },
    "/:categoryId": {
      POST: updateTemplateCategory,
      DELETE: deleteTemplateCategory,
    },
  },
  { prefix: "/template-categories" },
);
