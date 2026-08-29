import {
  GLOBAL_SEARCH_RESULT_TYPES,
  type GlobalSearchResultType,
} from "@stll/api-contract";

import type {
  SearchFilters,
  TimeFilter,
} from "@/components/search-filters.logic";
import type { TranslationKey } from "@/i18n/types";
import type { EntityKind, GlobalSearchHit } from "@/lib/api-contract";
import type { TimePreset } from "@/lib/search";

export const SEARCH_PREVIEW_CONTENT_CLASS_NAME =
  "text-foreground/90 [&_mark]:bg-highlight [&_mark]:text-highlight-foreground text-sm leading-6 whitespace-pre-wrap [&_mark]:font-medium";
export const SEARCH_PREVIEW_COLUMN_CLASS_NAME =
  "hidden min-h-0 w-[var(--search-preview-w,min(44%,32rem))] min-w-72 shrink-0 flex-col overflow-hidden border-s md:flex";

export const KIND_TRANSLATION_KEYS = {
  matter: "search.kinds.matter",
  contact: "search.kinds.contact",
  "case-law": "search.kinds.caseLaw",
  document: "common.document",
  folder: "search.kinds.folder",
  task: "search.kinds.task",
  message: "search.kinds.message",
  link: "search.kinds.link",
  chat: "search.kinds.chat",
} as const satisfies Record<GlobalSearchResultType, TranslationKey>;

export const TIME_PRESET_TRANSLATION_KEYS = {
  day: "search.updatedWithinOptions.day",
  week: "search.updatedWithinOptions.week",
  month: "search.updatedWithinOptions.month",
  year: "search.updatedWithinOptions.year",
} as const satisfies Record<TimePreset, TranslationKey>;

export type FacetBucket = { value: string; label?: string; count: number };

export const EMPTY_FACET_BUCKETS: readonly FacetBucket[] = [];
export const EMPTY_SEARCH_HITS: readonly GlobalSearchHit[] = [];
export const EMPTY_SEARCH_PREVIEW_LOCATOR_CANDIDATES: readonly string[] = [];

export const isSearchKindOption = (
  value: string,
): value is GlobalSearchResultType =>
  GLOBAL_SEARCH_RESULT_TYPES.some((type) => type === value);

export const isAvailableSearchKind = (
  type: GlobalSearchResultType,
  includePublicLaw: boolean,
): boolean => type !== "case-law" || includePublicLaw;

export const compactMeta = (
  parts: readonly (string | null | undefined)[],
): string =>
  parts
    .flatMap((part) => {
      const trimmed = part?.trim();
      return trimmed ? [trimmed] : [];
    })
    .join(" · ");

export const formatMimeTypeLabel = (mimeType: string): string => {
  if (mimeType === "application/pdf") {
    return "PDF";
  }
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "DOCX";
  }
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "XLSX";
  }
  if (mimeType.startsWith("image/")) {
    return mimeType.replace("image/", "").toUpperCase();
  }
  if (mimeType.startsWith("text/")) {
    return mimeType.replace("text/", "").toUpperCase();
  }
  return mimeType;
};

export const isoToDateInputValue = (iso: string): string => iso.slice(0, 10);

export const dateInputToIsoStart = (value: string): string =>
  new Date(`${value}T00:00:00.000Z`).toISOString();

export const dateInputToIsoEnd = (value: string): string =>
  new Date(`${value}T23:59:59.999Z`).toISOString();

export const mergeSelectedBuckets = (
  buckets: FacetBucket[],
  selected: string[],
  getLabel: (value: string) => string,
): FacetBucket[] => {
  const present = new Set(buckets.map((bucket) => bucket.value));
  const missing = selected.flatMap((value) =>
    present.has(value) ? [] : [{ value, label: getLabel(value), count: 0 }],
  );
  return [...buckets, ...missing];
};

export const initialSearchFilters = (
  initialWorkspaceId: string | undefined,
): SearchFilters => ({
  editedByUserIds: [],
  kinds: [],
  mimeTypes: [],
  types: [],
  workspaceIds: initialWorkspaceId ? [initialWorkspaceId] : [],
});

export type SearchFacetParams = {
  enabled: boolean;
  organizationId: string;
  userId: string;
  query: string;
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  kinds: EntityKind[];
  editedByUserIds: string[];
  mimeTypes: string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
};

export type SearchTimeFilter = TimeFilter;
