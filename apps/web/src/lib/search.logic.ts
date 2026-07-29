import type { GlobalSearchHit, GlobalSearchResultType } from "@stll/api/types";

export const normalizeSearchQuery = (query: string): string => query.trim();

type SelectSearchPreviewHitArgs = {
  highlightedHitId: string | null;
  hits: readonly GlobalSearchHit[];
  isPlaceholderData: boolean;
  query: string;
};

export const selectSearchPreviewHit = ({
  highlightedHitId,
  hits,
  isPlaceholderData,
  query,
}: SelectSearchPreviewHitArgs): GlobalSearchHit | null => {
  if (isPlaceholderData || normalizeSearchQuery(query) === "") {
    return null;
  }
  return hits.find((hit) => hit.id === highlightedHitId) ?? hits.at(0) ?? null;
};

type SearchPreviewTarget = {
  resultId: string;
  type: GlobalSearchResultType;
};

export const getSearchPreviewTarget = (
  hit: GlobalSearchHit,
): SearchPreviewTarget => {
  switch (hit.type) {
    case "matter":
      return { resultId: hit.workspaceId, type: hit.type };
    case "contact":
      return { resultId: hit.contactId, type: hit.type };
    case "case-law":
      return { resultId: hit.decisionId, type: hit.type };
    case "chat":
      return { resultId: hit.threadId, type: hit.type };
    case "document":
    case "folder":
    case "task":
    case "message":
    case "link":
      return { resultId: hit.entityId, type: hit.type };
    default: {
      const exhaustive: never = hit;
      return exhaustive;
    }
  }
};
