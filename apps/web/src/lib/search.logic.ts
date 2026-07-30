import type { GlobalSearchHit, GlobalSearchResultType } from "@stll/api/types";

export const normalizeSearchQuery = (query: string): string => query.trim();

export const stripSearchMarkup = (value: string): string =>
  value.replaceAll("<mark>", " ").replaceAll("</mark>", " ").trim();

type SearchPreviewContent =
  | {
      content: string;
      type: "highlighted-html";
    }
  | {
      content: string;
      type: "plain-text";
    };

type SearchPreviewRenderContent =
  | {
      directionText: string;
      html: string;
      type: "highlighted-html";
    }
  | {
      directionText: string;
      text: string;
      type: "plain-text";
    };

export const getSearchPreviewRenderContent = (
  preview: SearchPreviewContent,
): SearchPreviewRenderContent => {
  switch (preview.type) {
    case "highlighted-html":
      return {
        type: preview.type,
        directionText: stripSearchMarkup(preview.content),
        html: preview.content,
      };
    case "plain-text":
      return {
        type: preview.type,
        directionText: preview.content,
        text: preview.content,
      };
    default: {
      const exhaustive: never = preview;
      return exhaustive;
    }
  }
};

type SearchPreviewVisibilityArgs = {
  isMobile: boolean;
  previewEnabled: boolean;
};

export const shouldShowSearchPreview = ({
  isMobile,
  previewEnabled,
}: SearchPreviewVisibilityArgs): boolean => previewEnabled && !isMobile;

type AuthorizedSearchPreviewDataArgs<T> = {
  data: T | undefined;
  isError: boolean;
  isFetchedAfterMount: boolean;
  isFetching: boolean;
};

export const selectAuthorizedSearchPreviewData = <T>({
  data,
  isError,
  isFetchedAfterMount,
}: AuthorizedSearchPreviewDataArgs<T>): T | undefined =>
  isFetchedAfterMount && !isError ? data : undefined;

type SelectSearchPreviewHitArgs = {
  highlightedHitId: string | null;
  hits: readonly GlobalSearchHit[];
  isPlaceholderData: boolean;
};

export const selectSearchPreviewHit = ({
  highlightedHitId,
  hits,
  isPlaceholderData,
}: SelectSearchPreviewHitArgs): GlobalSearchHit | null => {
  if (isPlaceholderData) {
    return null;
  }
  return hits.find((hit) => hit.id === highlightedHitId) ?? hits.at(0) ?? null;
};

type SearchPreviewTarget = {
  resultId: string;
  type: GlobalSearchResultType;
};

export type SearchPreviewDate =
  | { type: "calendar-date"; value: string }
  | { type: "instant"; value: string };

export const getSearchPreviewDate = (
  hit: GlobalSearchHit,
): SearchPreviewDate | null => {
  if (hit.type === "case-law") {
    return hit.decisionDate
      ? { type: "calendar-date", value: hit.decisionDate }
      : null;
  }
  return { type: "instant", value: hit.updatedAt };
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
