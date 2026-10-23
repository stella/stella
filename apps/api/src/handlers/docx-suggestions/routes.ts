import createDocxSuggestions from "@/api/handlers/docx-suggestions/create";
import listDocxSuggestions from "@/api/handlers/docx-suggestions/list";
import rejectPendingDocxSuggestions from "@/api/handlers/docx-suggestions/reject-pending";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
import { routes } from "@/api/http/route";

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
export const docxSuggestionsRoute = routes(
  {
    "/entity/:entityId": {
      PUT: createDocxSuggestions,
      GET: listDocxSuggestions,
    },
    "/entity/:entityId/reject-pending": { PATCH: rejectPendingDocxSuggestions },
    "/entity/:entityId/suggestion/:suggestionId/resolve": {
      PATCH: resolveDocxSuggestion,
    },
    "/entity/:entityId/suggestion/:suggestionId/revert": {
      PATCH: revertDocxSuggestion,
    },
  },
  { prefix: "/docx-suggestions/:workspaceId" },
);
