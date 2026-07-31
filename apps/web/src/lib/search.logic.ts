import type { GlobalSearchHit, GlobalSearchResultType } from "@stll/api/types";

import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

export const normalizeSearchQuery = (query: string): string => query.trim();

export const stripSearchMarkup = (value: string): string =>
  value.replaceAll("<mark>", " ").replaceAll("</mark>", " ").trim();

const SEARCH_HEADLINE_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};
const MAX_UNICODE_CODE_POINT = 1_114_111;
const SEARCH_HEADLINE_ENTITY = /&(?:#x[\da-f]+|#\d+|[a-z]+);/giu;

const decodeSearchHeadlineEntities = (value: string): string =>
  value.replace(SEARCH_HEADLINE_ENTITY, (encoded) => {
    const entity = encoded.slice(1, -1);
    const normalizedEntity = entity.toLowerCase();
    if (normalizedEntity.startsWith("#x")) {
      const codePoint = Number.parseInt(normalizedEntity.slice(2), 16);
      return codePoint <= MAX_UNICODE_CODE_POINT
        ? String.fromCodePoint(codePoint)
        : encoded;
    }
    if (normalizedEntity.startsWith("#")) {
      const codePoint = Number.parseInt(normalizedEntity.slice(1), 10);
      return codePoint <= MAX_UNICODE_CODE_POINT
        ? String.fromCodePoint(codePoint)
        : encoded;
    }
    return SEARCH_HEADLINE_NAMED_ENTITIES[normalizedEntity] ?? encoded;
  });

const getMarkedSearchTerms = (headline: string | null): string[] => {
  if (!headline) {
    return [];
  }

  const terms: string[] = [];
  for (const match of headline.matchAll(/<mark>(?<term>.*?)<\/mark>/gu)) {
    const encodedTerm = match.groups?.["term"]?.trim();
    const term = encodedTerm
      ? decodeSearchHeadlineEntities(encodedTerm).trim()
      : undefined;
    if (term && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms;
};

export const getSearchHighlightText = (
  headline: string | null,
  query: string,
): string => {
  const normalizedQuery = normalizeSearchQuery(query);
  const markedSearchText = getMarkedSearchTerms(headline).join(" ");
  if (markedSearchText) {
    return markedSearchText;
  }

  if (normalizedQuery) {
    return normalizedQuery;
  }

  return headline ? stripSearchMarkup(headline) : "";
};

export const getFirstSearchHighlightText = (
  headline: string | null,
  query: string,
): string => {
  const markedSearchText = getMarkedSearchTerms(headline).at(0);
  return markedSearchText ?? getSearchHighlightText(headline, query);
};

type SearchPreviewContent =
  | {
      messages: SearchPreviewChatMessage[];
      type: "chat-messages";
    }
  | {
      content: string;
      type: "highlighted-html";
    }
  | {
      content: string;
      type: "plain-text";
    };

export type SearchPreviewChatMessage = {
  content: string;
  id: string;
  role: "assistant" | "system" | "user";
};

type SearchPreviewRenderContent =
  | {
      messages: SearchPreviewChatMessage[];
      type: "chat-messages";
    }
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
    case "chat-messages":
      return { type: preview.type, messages: preview.messages };
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

type DisplayedSearchPreviewHitArgs = {
  hit: GlobalSearchHit | null;
  showPreview: boolean;
};

export const selectDisplayedSearchPreviewHit = ({
  hit,
  showPreview,
}: DisplayedSearchPreviewHitArgs): GlobalSearchHit | null =>
  showPreview ? hit : null;

export type NativeSearchDocumentPreviewTarget = {
  entityId: string;
  fieldId: string;
  filePurpose: "display" | "native-display";
  mimeType: typeof DOCX_MIME | typeof PDF_MIME;
  workspaceId: string;
};

export type NativeSearchStatus = "matched" | "pending" | "unmatched";

type NativeSearchFallbackArgs = {
  searchText: string;
  status: NativeSearchStatus;
};

export const shouldShowNativeSearchFallback = ({
  searchText,
  status,
}: NativeSearchFallbackArgs): boolean =>
  searchText.trim().length > 0 && status === "unmatched";

export const getNativeSearchDocumentPreviewTarget = (
  hit: GlobalSearchHit,
): NativeSearchDocumentPreviewTarget | null => {
  if (hit.type !== "document" || hit.fileFieldId === null) {
    return null;
  }

  if (hit.mimeType === PDF_MIME) {
    return {
      entityId: hit.entityId,
      fieldId: hit.fileFieldId,
      filePurpose: "display",
      mimeType: hit.mimeType,
      workspaceId: hit.workspaceId,
    };
  }

  if (hit.mimeType === DOCX_MIME) {
    return {
      entityId: hit.entityId,
      fieldId: hit.fileFieldId,
      filePurpose: "native-display",
      mimeType: hit.mimeType,
      workspaceId: hit.workspaceId,
    };
  }

  return null;
};

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
