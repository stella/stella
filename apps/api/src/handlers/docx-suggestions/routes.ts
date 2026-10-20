import Elysia from "elysia";

import createDocxSuggestions from "@/api/handlers/docx-suggestions/create";
import listDocxSuggestions from "@/api/handlers/docx-suggestions/read";
import rejectPendingDocxSuggestions from "@/api/handlers/docx-suggestions/reject-pending";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

/**
 * Persistence for AI DOCX review suggestions, entity-scoped under a
 * server-validated workspace. Thin: structure + macro wiring only; each
 * handler owns its schema, permissions, and business logic.
 *
 * No realtime event: the client review store is the source of truth during a
 * session (it updates optimistically and reconciles server ids), and the
 * suggestion list query only runs on document open to hydrate. A server-driven
 * cache invalidation would trigger a redundant refetch that the store reflects.
 */
export const docxSuggestionsRoute = new Elysia({
  prefix: "/docx-suggestions/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put(
    "/entity/:entityId",
    {
      body: createDocxSuggestions.config.body,
      params: createDocxSuggestions.config.params,
      permissions: createDocxSuggestions.config.permissions,
    },
    createDocxSuggestions.handler,
  )
  .get(
    "/entity/:entityId",
    {
      params: listDocxSuggestions.config.params,
      query: listDocxSuggestions.config.query,
      permissions: listDocxSuggestions.config.permissions,
    },
    listDocxSuggestions.handler,
  )
  .patch(
    "/entity/:entityId/reject-pending",
    {
      body: rejectPendingDocxSuggestions.config.body,
      params: rejectPendingDocxSuggestions.config.params,
      permissions: rejectPendingDocxSuggestions.config.permissions,
    },
    rejectPendingDocxSuggestions.handler,
  )
  .patch(
    "/entity/:entityId/suggestion/:suggestionId/resolve",
    {
      body: resolveDocxSuggestion.config.body,
      params: resolveDocxSuggestion.config.params,
      permissions: resolveDocxSuggestion.config.permissions,
    },
    resolveDocxSuggestion.handler,
  )
  .patch(
    "/entity/:entityId/suggestion/:suggestionId/revert",
    {
      params: revertDocxSuggestion.config.params,
      permissions: revertDocxSuggestion.config.permissions,
    },
    revertDocxSuggestion.handler,
  );
