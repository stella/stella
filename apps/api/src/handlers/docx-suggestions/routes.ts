import Elysia from "elysia";

import createDocxSuggestions from "@/api/handlers/docx-suggestions/create";
import listDocxSuggestions from "@/api/handlers/docx-suggestions/read";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

/**
 * Persistence for AI DOCX review suggestions, entity-scoped under a
 * server-validated workspace. Thin: structure + macro wiring only; each
 * handler owns its schema, permissions, and business logic.
 *
 * No `invalidateQuery`: the client review store is the source of truth
 * during a session (it updates optimistically and reconciles server ids),
 * and the suggestion list query only runs on document open to hydrate. A
 * server-driven cache invalidation would just trigger a redundant refetch
 * that the store already reflects.
 */
export const docxSuggestionsRoute = new Elysia({
  prefix: "/docx-suggestions/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/entity/:entityId", createDocxSuggestions.handler, {
    body: createDocxSuggestions.config.body,
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
      params: resolveDocxSuggestion.config.params,
      permissions: resolveDocxSuggestion.config.permissions,
    },
  )
  .patch(
    "/entity/:entityId/suggestion/:suggestionId/revert",
    revertDocxSuggestion.handler,
    {
      params: revertDocxSuggestion.config.params,
      permissions: revertDocxSuggestion.config.permissions,
    },
  );
