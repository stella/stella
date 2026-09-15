/**
 * Keeps the persisted-suggestion list cache truthful to server pending state.
 *
 * `useSyncDocxSuggestions` merges every row of this cache into the review
 * store whenever its effect re-runs, and a thread reset clears only memory. A
 * row resolved on the server but still listed here would therefore come back
 * as actionable after any reset. The persistence transport calls this after
 * every successful write that moves a row into or out of `pending`.
 */

import type { InferDataFromTag, QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { ClientTelemetryError } from "@/lib/errors/telemetry";
import { docxSuggestionsOptions } from "@/lib/workspaces/queries/docx-suggestions";

type DocxSuggestionsQueryData = InferDataFromTag<
  unknown,
  ReturnType<typeof docxSuggestionsOptions>["queryKey"]
>;

type DocxSuggestionRow = DocxSuggestionsQueryData["items"][number];

export const DOCX_SUGGESTION_CACHE_WRITE = {
  leavePending: "leave-pending",
  enterPending: "enter-pending",
} as const;

type DocxSuggestionCacheWrite =
  | {
      type: typeof DOCX_SUGGESTION_CACHE_WRITE.leavePending;
      suggestionIds: readonly string[];
    }
  | {
      type: typeof DOCX_SUGGESTION_CACHE_WRITE.enterPending;
      rows: readonly DocxSuggestionRow[];
    };

type WriteDocxSuggestionsCacheOptions = {
  queryClient: QueryClient;
  workspaceId: string;
  entityId: string;
  write: DocxSuggestionCacheWrite;
};

/**
 * Apply one pending-state change to the cached list. A list that has not
 * loaded yet is left alone: its first fetch reads the server directly.
 */
export const writeDocxSuggestionsCache = ({
  queryClient,
  workspaceId,
  entityId,
  write,
}: WriteDocxSuggestionsCacheOptions): void => {
  queryClient.setQueryData(
    docxSuggestionsOptions({ workspaceId, entityId }).queryKey,
    (current) => {
      if (current === undefined) {
        return current;
      }
      switch (write.type) {
        case DOCX_SUGGESTION_CACHE_WRITE.leavePending: {
          const leaving = new Set(write.suggestionIds);
          const items = current.items.filter((row) => !leaving.has(row.id));
          return items.length === current.items.length
            ? current
            : { ...current, items };
        }
        case DOCX_SUGGESTION_CACHE_WRITE.enterPending: {
          const present = new Set<string>(current.items.map((row) => row.id));
          const entering = write.rows.filter((row) => !present.has(row.id));
          return entering.length === 0
            ? current
            : { ...current, items: [...current.items, ...entering] };
        }
        default: {
          write satisfies never;
          return panic("Unhandled docx suggestion cache write");
        }
      }
    },
  );
};

/**
 * The cached pending row for a suggestion the server holds under `id`. A
 * suggestion without an operation never reaches the server, so asking for its
 * row is a caller bug: reported, and no row is produced.
 */
export const pendingDocxSuggestionRow = (
  suggestion: ReviewSuggestion,
  id: DocxSuggestionRow["id"],
): DocxSuggestionRow | null => {
  if (suggestion.pendingOperation === null) {
    getAnalytics().captureError(
      new ClientTelemetryError({
        area: "docx-suggestion-cache",
        message:
          "A pending DOCX suggestion row was built without an operation.",
      }),
    );
    return null;
  }
  return {
    id,
    opPayload: suggestion.pendingOperation,
    comment: suggestion.comment ?? null,
    severity: suggestion.severity,
    area: suggestion.area,
    status: "pending",
    appliedMode: null,
    createdAt: new Date(),
    origin: suggestion.origin,
  };
};
