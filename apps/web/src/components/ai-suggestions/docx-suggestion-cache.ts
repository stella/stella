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
import { detached } from "@/lib/detached";
import { ClientTelemetryError } from "@/lib/errors/telemetry";
import { toSafeId } from "@/lib/safe-id";
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

// The list endpoint's order (created_at, then id, ascending), so hydration
// after a cache write sees the rows as a fresh fetch would return them.
const inServerOrder = (a: DocxSuggestionRow, b: DocxSuggestionRow): number => {
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
};

/**
 * Apply one pending-state change to the cached list. A list that has not
 * loaded yet is left alone: its first fetch reads the server directly.
 */
export const writeDocxSuggestionsCache = async ({
  queryClient,
  workspaceId,
  entityId,
  write,
}: WriteDocxSuggestionsCacheOptions): Promise<void> => {
  const { queryKey } = docxSuggestionsOptions({ workspaceId, entityId });
  // A list fetch that started before this write can carry the rows as they
  // were before it. Cancel it, so it cannot land afterwards and undo the write.
  const cancelledFetch =
    queryClient.getQueryState(queryKey)?.fetchStatus === "fetching";
  if (cancelledFetch) {
    await queryClient.cancelQueries({ queryKey, exact: true });
  }
  queryClient.setQueryData(queryKey, (current) => {
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
          : {
              ...current,
              items: [...current.items, ...entering].toSorted(inServerOrder),
            };
      }
      default: {
        write satisfies never;
        return panic("Unhandled docx suggestion cache write");
      }
    }
  });
  if (cancelledFetch && queryClient.getQueryData(queryKey) === undefined) {
    // The cancelled fetch was the list's first, so no data was updated.
    // Mounted readers fetch again, now after this write.
    detached(
      queryClient.refetchQueries({ queryKey, exact: true, type: "active" }),
      "docx-suggestion-cache.refetch-after-cancel",
    );
  }
};

/**
 * Read the pending list from the server again, for a write whose effect on
 * the list is not known. Mounted readers refetch; a list nobody reads is marked
 * stale, so its next reader fetches.
 */
export const refetchDocxSuggestionsList = async ({
  queryClient,
  workspaceId,
  entityId,
}: Omit<WriteDocxSuggestionsCacheOptions, "write">): Promise<void> => {
  await queryClient.invalidateQueries({
    queryKey: docxSuggestionsOptions({ workspaceId, entityId }).queryKey,
    exact: true,
  });
};

type ServerSuggestionIdentity = {
  id: DocxSuggestionRow["id"];
  createdAt: Date;
};

const reportMissingRowField = (message: string) => {
  getAnalytics().captureError(
    new ClientTelemetryError({ area: "docx-suggestion-cache", message }),
  );
};

// A suggestion without an operation never reaches the server, so asking for
// its row is a caller bug: reported, and no row is produced.
const pendingDocxSuggestionRow = (
  suggestion: ReviewSuggestion,
  server: ServerSuggestionIdentity,
): DocxSuggestionRow | null => {
  if (suggestion.pendingOperation === null) {
    reportMissingRowField(
      "A pending DOCX suggestion row was built without an operation.",
    );
    return null;
  }
  return {
    id: server.id,
    opPayload: suggestion.pendingOperation,
    comment: suggestion.comment ?? null,
    severity: suggestion.severity,
    area: suggestion.area,
    status: "pending",
    appliedMode: null,
    createdAt: server.createdAt,
    origin: suggestion.origin,
  };
};

type CreatedDocxSuggestionRowsOptions = {
  suggestions: readonly ReviewSuggestion[];
  created: readonly { ref: string; id: DocxSuggestionRow["id"] }[];
  /** The server timestamp shared by every row of the create batch. */
  createdAt: Date;
};

/**
 * The cached pending rows for one create batch, all carrying the batch's
 * server `createdAt`, as a list fetch would return them.
 */
export const createdDocxSuggestionRows = ({
  suggestions,
  created,
  createdAt,
}: CreatedDocxSuggestionRowsOptions): DocxSuggestionRow[] => {
  const suggestionsByRef = new Map(suggestions.map((item) => [item.id, item]));
  return created.flatMap(({ ref, id }) => {
    const suggestion = suggestionsByRef.get(ref);
    const row =
      suggestion === undefined
        ? null
        : pendingDocxSuggestionRow(suggestion, { id, createdAt });
    return row === null ? [] : [row];
  });
};

/**
 * The cached pending row for a reverted suggestion. It keeps the `createdAt`
 * the server persisted it with, so it rejoins its original batch.
 */
export const revertedDocxSuggestionRow = (
  suggestion: ReviewSuggestion,
): DocxSuggestionRow | null => {
  if (suggestion.createdAt === undefined) {
    reportMissingRowField(
      "A reverted DOCX suggestion has no server createdAt.",
    );
    return null;
  }
  return pendingDocxSuggestionRow(suggestion, {
    id: toSafeId<"docxSuggestion">(suggestion.id),
    createdAt: suggestion.createdAt,
  });
};
