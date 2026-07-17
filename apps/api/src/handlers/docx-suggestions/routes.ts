import Elysia from "elysia";

import createDocxSuggestions from "@/api/handlers/docx-suggestions/create";
import listDocxSuggestions from "@/api/handlers/docx-suggestions/read";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

/**
 * Persistence for AI DOCX review suggestions, entity-scoped under a
 * server-validated workspace. Thin: structure + macro wiring only; each
 * handler owns its schema, permissions, and business logic.
 */
export const docxSuggestionsRoute = new Elysia({
  prefix: "/docx-suggestions/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/entity/:entityId", createDocxSuggestions.handler, {
    body: createDocxSuggestions.config.body,
    invalidateQuery: true,
    params: createDocxSuggestions.config.params,
    permissions: createDocxSuggestions.config.permissions,
  })
  .get("/entity/:entityId", listDocxSuggestions.handler, {
    params: listDocxSuggestions.config.params,
    query: listDocxSuggestions.config.query,
    permissions: listDocxSuggestions.config.permissions,
  })
  .patch(
    "/entity/:entityId/suggestion/:suggestionId/resolve",
    resolveDocxSuggestion.handler,
    {
      body: resolveDocxSuggestion.config.body,
      invalidateQuery: true,
      params: resolveDocxSuggestion.config.params,
      permissions: resolveDocxSuggestion.config.permissions,
    },
  )
  .patch(
    "/entity/:entityId/suggestion/:suggestionId/revert",
    revertDocxSuggestion.handler,
    {
      invalidateQuery: true,
      params: revertDocxSuggestion.config.params,
      permissions: revertDocxSuggestion.config.permissions,
    },
  );
