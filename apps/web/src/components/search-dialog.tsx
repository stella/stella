import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  GlobalSearchHit,
  GlobalSearchResultType,
  GlobalSearchUpdatedWithin,
} from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  LayersIcon,
  LandmarkIcon,
  LinkIcon,
  LoaderIcon,
  MessageSquareIcon,
  SearchIcon,
  SparklesIcon,
  SquareCheckIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useLocale, useTranslations } from "use-intl";

import { UserAvatar } from "@/components/user-avatar";
import {
  createSearchSummaryChatThread,
  refineSearchQuery,
  searchInfiniteOptions,
  summarizeSearchResults,
} from "@/lib/search";
import {
  readRecentFiles,
  readRecentSearches,
  recordRecentFile,
  recordRecentSearch,
} from "@/lib/search-recents";
import type {
  RecentFile,
  RecentSearch,
  SearchRecentsScope,
} from "@/lib/search-recents";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

const DEBOUNCE_MS = 300;

const KIND_ICONS = {
  matter: LayersIcon,
  contact: UserIcon,
  "case-law": LandmarkIcon,
  document: FileTextIcon,
  folder: FolderIcon,
  task: SquareCheckIcon,
  message: MessageSquareIcon,
  link: LinkIcon,
} as const satisfies Record<GlobalSearchResultType, typeof FileTextIcon>;

const KIND_TRANSLATION_KEYS = {
  matter: "search.kinds.matter",
  contact: "search.kinds.contact",
  "case-law": "search.kinds.caseLaw",
  document: "search.kinds.document",
  folder: "search.kinds.folder",
  task: "search.kinds.task",
  message: "search.kinds.message",
  link: "search.kinds.link",
} as const satisfies Record<GlobalSearchResultType, string>;

const UPDATED_WITHIN_OPTIONS = ["day", "week", "month", "year"] as const;

const UPDATED_WITHIN_TRANSLATION_KEYS = {
  day: "search.updatedWithinOptions.day",
  week: "search.updatedWithinOptions.week",
  month: "search.updatedWithinOptions.month",
  year: "search.updatedWithinOptions.year",
} as const satisfies Record<GlobalSearchUpdatedWithin, string>;

const isGlobalSearchResultType = (
  value: string,
): value is GlobalSearchResultType => value in KIND_TRANSLATION_KEYS;

const compactMeta = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .flatMap((part) => {
      const trimmed = part?.trim();
      return trimmed ? [trimmed] : [];
    })
    .join(" · ");

const stripSearchMarkup = (value: string): string =>
  value.replaceAll("<mark>", " ").replaceAll("</mark>", " ").trim();

const extractHighlightedText = (headline: string): string => {
  const start = headline.indexOf("<mark>");
  const end = headline.indexOf("</mark>", start);
  if (start === -1 || end === -1 || end <= start) {
    return stripSearchMarkup(headline);
  }
  return stripSearchMarkup(headline.slice(start + "<mark>".length, end));
};

const formatMimeTypeLabel = (mimeType: string): string => {
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

const initialSearchFilters = (
  initialWorkspaceId: string | undefined,
): SearchFilters => ({
  ...(initialWorkspaceId !== undefined && {
    workspaceId: initialWorkspaceId,
  }),
});

type SearchFilters = {
  workspaceId?: string;
  types?: GlobalSearchResultType[];
  editedByUserId?: string;
  mimeTypes?: string[];
  updatedWithin?: GlobalSearchUpdatedWithin;
};

type SearchSummaryState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      title: string;
      summary: string;
      citations: {
        id: string;
        number: number;
        title: string;
        type: string;
        reason: string;
      }[];
    }
  | { status: "error"; message?: string };

type OptimizedSearchQuery = {
  originalQuery: string;
  query: string;
};

type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialWorkspaceId?: string | undefined;
};

export const SearchDialog = ({
  open,
  onOpenChange,
  initialWorkspaceId,
}: SearchDialogProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const navigate = useNavigate();
  const searchRecentsUserId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });
  const searchRecentsOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const searchRecentsScope = useMemo(
    (): SearchRecentsScope => ({
      organizationId: searchRecentsOrganizationId,
      userId: searchRecentsUserId,
    }),
    [searchRecentsOrganizationId, searchRecentsUserId],
  );
  const resultsRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [filters, setFilters] = useState<SearchFilters>(() =>
    initialSearchFilters(initialWorkspaceId),
  );
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isRefiningQuery, setIsRefiningQuery] = useState(false);
  const [isOpeningSummaryChat, setIsOpeningSummaryChat] = useState(false);
  const [summaryState, setSummaryState] = useState<SearchSummaryState>({
    status: "idle",
  });
  const [optimizedSearchQuery, setOptimizedSearchQuery] =
    useState<OptimizedSearchQuery | null>(null);

  const debouncedSetQuery = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
    setSelectedIndex(-1);
  }, DEBOUNCE_MS);

  const searchQuery = optimizedSearchQuery?.query ?? debouncedQuery;

  const {
    data,
    isLoading,
    isFetching,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    searchInfiniteOptions({
      query: searchQuery,
      ...(filters.workspaceId !== undefined && {
        workspaceId: filters.workspaceId,
      }),
      ...(filters.types !== undefined && { types: filters.types }),
      ...(filters.editedByUserId !== undefined && {
        editedByUserId: filters.editedByUserId,
      }),
      ...(filters.mimeTypes !== undefined && { mimeTypes: filters.mimeTypes }),
      ...(filters.updatedWithin !== undefined && {
        updatedWithin: filters.updatedWithin,
      }),
    }),
  );

  const allHits = useMemo(
    () => data?.pages.flatMap((page) => page.hits) ?? [],
    [data?.pages],
  );
  const latestPage = data?.pages.at(-1);
  const facets = latestPage?.facets;
  const totalCount = latestPage?.totalCount ?? 0;
  const filterTypesKey = filters.types?.join("|") ?? "";
  const filterMimeTypesKey = filters.mimeTypes?.join("|") ?? "";

  useEffect(() => {
    if (!open) {
      return;
    }
    setRecentSearches(readRecentSearches(searchRecentsScope));
    setRecentFiles(readRecentFiles(searchRecentsScope));
  }, [open, searchRecentsScope]);

  useEffect(() => {
    setFilters((prev): SearchFilters => {
      const { workspaceId: _, ...rest } = prev;
      if (initialWorkspaceId === undefined) {
        return rest;
      }
      return { ...rest, workspaceId: initialWorkspaceId };
    });
    setSelectedIndex(-1);
  }, [initialWorkspaceId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = resultsRef.current?.querySelector("[data-selected]");
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);
      debouncedSetQuery(value);
      setOptimizedSearchQuery(null);
      setSummaryState({ status: "idle" });
    },
    [debouncedSetQuery],
  );

  const clearSearchQuery = useCallback(() => {
    debouncedSetQuery.cancel();
    setQuery("");
    setDebouncedQuery("");
    setOptimizedSearchQuery(null);
    setSelectedIndex(-1);
    setSummaryState({ status: "idle" });
  }, [debouncedSetQuery]);

  const closeSearchDialog = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleRefineQuery = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || isRefiningQuery) {
      return;
    }

    setIsRefiningQuery(true);
    try {
      const refined = await refineSearchQuery({
        query: trimmedQuery,
        locale,
      });
      setDebouncedQuery(trimmedQuery);
      setOptimizedSearchQuery({
        originalQuery: trimmedQuery,
        query: refined.query,
      });
      setSelectedIndex(-1);
      setSummaryState({ status: "idle" });
      setRecentSearches(recordRecentSearch(trimmedQuery, searchRecentsScope));
    } catch {
      setSummaryState({ status: "error" });
    } finally {
      setIsRefiningQuery(false);
    }
  }, [isRefiningQuery, locale, query, searchRecentsScope]);

  const handleSummarizeResults = useCallback(async () => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery || summaryState.status === "loading") {
      return;
    }

    setSummaryState({ status: "loading" });
    try {
      const summary = await summarizeSearchResults({
        query: trimmedQuery,
        locale,
        ...(optimizedSearchQuery?.originalQuery !== undefined && {
          originalQuery: optimizedSearchQuery.originalQuery,
        }),
        ...(filters.workspaceId !== undefined && {
          workspaceId: filters.workspaceId,
        }),
        ...(filters.types !== undefined && { types: filters.types }),
        ...(filters.editedByUserId !== undefined && {
          editedByUserId: filters.editedByUserId,
        }),
        ...(filters.mimeTypes !== undefined && {
          mimeTypes: filters.mimeTypes,
        }),
        ...(filters.updatedWithin !== undefined && {
          updatedWithin: filters.updatedWithin,
        }),
        limit: 5,
      });
      setSummaryState({
        status: "ready",
        title: summary.title,
        summary: summary.summary,
        citations: summary.citations,
      });
    } catch {
      setSummaryState({ status: "error" });
    }
  }, [
    filters.types,
    filters.editedByUserId,
    filters.mimeTypes,
    filters.updatedWithin,
    filters.workspaceId,
    locale,
    optimizedSearchQuery?.originalQuery,
    searchQuery,
    summaryState.status,
  ]);

  const handleOpenSummaryChat = useCallback(async () => {
    const trimmedQuery = searchQuery.trim();
    if (summaryState.status !== "ready" || !trimmedQuery) {
      return;
    }

    setIsOpeningSummaryChat(true);
    try {
      const thread = await createSearchSummaryChatThread({
        query: trimmedQuery,
        locale,
        title: summaryState.title,
        summary: summaryState.summary,
        citations: summaryState.citations,
        ...(optimizedSearchQuery?.originalQuery !== undefined && {
          originalQuery: optimizedSearchQuery.originalQuery,
        }),
        ...(filters.workspaceId !== undefined && {
          workspaceId: filters.workspaceId,
        }),
        ...(filters.types !== undefined && { types: filters.types }),
        ...(filters.editedByUserId !== undefined && {
          editedByUserId: filters.editedByUserId,
        }),
        ...(filters.mimeTypes !== undefined && {
          mimeTypes: filters.mimeTypes,
        }),
        ...(filters.updatedWithin !== undefined && {
          updatedWithin: filters.updatedWithin,
        }),
        limit: 5,
      });
      closeSearchDialog();
      await navigate({
        to: "/chat/$threadId",
        params: { threadId: thread.threadId },
      });
    } catch {
      setSummaryState({ status: "error" });
    } finally {
      setIsOpeningSummaryChat(false);
    }
  }, [
    filters.editedByUserId,
    filters.mimeTypes,
    filters.types,
    filters.updatedWithin,
    filters.workspaceId,
    locale,
    navigate,
    closeSearchDialog,
    optimizedSearchQuery?.originalQuery,
    searchQuery,
    summaryState,
  ]);

  const applyRecentSearch = useCallback(
    (recent: RecentSearch) => {
      setQuery(recent.query);
      setDebouncedQuery(recent.query);
      setOptimizedSearchQuery(null);
      setSelectedIndex(-1);
      setSummaryState({ status: "idle" });
      setRecentSearches(recordRecentSearch(recent.query, searchRecentsScope));
    },
    [searchRecentsScope],
  );

  const showOptimizedSearchQuery = useCallback(() => {
    if (!optimizedSearchQuery) {
      return;
    }
    setQuery(optimizedSearchQuery.query);
    setDebouncedQuery(optimizedSearchQuery.query);
    setOptimizedSearchQuery(null);
    setSelectedIndex(-1);
  }, [optimizedSearchQuery]);

  const openRecentFile = useCallback(
    async (file: RecentFile) => {
      closeSearchDialog();
      setRecentFiles(recordRecentFile(file, searchRecentsScope));
      await navigate({
        to: "/workspaces/$workspaceId/entities/$entityId",
        params: { workspaceId: file.workspaceId, entityId: file.entityId },
      });
    },
    [closeSearchDialog, navigate, searchRecentsScope],
  );

  const toggleTypeFilter = useCallback((type: GlobalSearchResultType) => {
    setFilters((prev) => {
      const current = prev.types ?? [];
      const next = current.includes(type)
        ? current.filter((item) => item !== type)
        : [...current, type];
      const { types: _, ...rest } = prev;
      return {
        ...rest,
        ...(next.length > 0 && { types: next }),
      };
    });
    setSelectedIndex(-1);
  }, []);

  const setWorkspaceFilter = useCallback((workspaceId: string | undefined) => {
    setFilters((prev): SearchFilters => {
      const { workspaceId: _, ...rest } = prev;
      if (!workspaceId) {
        return rest;
      }
      return { ...rest, workspaceId };
    });
    setSelectedIndex(-1);
  }, []);

  const setEditorFilter = useCallback((editedByUserId: string | undefined) => {
    setFilters((prev): SearchFilters => {
      const { editedByUserId: _, ...rest } = prev;
      if (!editedByUserId) {
        return rest;
      }
      return { ...rest, editedByUserId };
    });
    setSelectedIndex(-1);
  }, []);

  const setUpdatedWithinFilter = useCallback(
    (updatedWithin: GlobalSearchUpdatedWithin | undefined) => {
      setFilters((prev): SearchFilters => {
        const { updatedWithin: _, ...rest } = prev;
        if (!updatedWithin) {
          return rest;
        }
        return { ...rest, updatedWithin };
      });
      setSelectedIndex(-1);
    },
    [],
  );

  const toggleMimeTypeFilter = useCallback((mimeType: string) => {
    setFilters((prev) => {
      const current = prev.mimeTypes ?? [];
      const next = current.includes(mimeType)
        ? current.filter((item) => item !== mimeType)
        : [...current, mimeType];
      const { mimeTypes: _, ...rest } = prev;
      return {
        ...rest,
        ...(next.length > 0 && { mimeTypes: next }),
      };
    });
    setSelectedIndex(-1);
  }, []);

  const removeTypeFilter = useCallback((type: GlobalSearchResultType) => {
    setFilters((prev): SearchFilters => {
      const next = (prev.types ?? []).filter((item) => item !== type);
      const { types: _, ...rest } = prev;
      if (next.length === 0) {
        return rest;
      }
      return { ...rest, types: next };
    });
    setSelectedIndex(-1);
  }, []);

  const removeMimeTypeFilter = useCallback((mimeType: string) => {
    setFilters((prev): SearchFilters => {
      const next = (prev.mimeTypes ?? []).filter((item) => item !== mimeType);
      const { mimeTypes: _, ...rest } = prev;
      if (next.length === 0) {
        return rest;
      }
      return { ...rest, mimeTypes: next };
    });
    setSelectedIndex(-1);
  }, []);

  const handleResultClick = useCallback(
    async (hit: GlobalSearchHit) => {
      if (query.trim()) {
        setRecentSearches(recordRecentSearch(query, searchRecentsScope));
      }

      closeSearchDialog();
      if (hit.type === "contact") {
        await navigate({
          to: "/contacts/$contactId",
          params: { contactId: hit.contactId },
        });
        return;
      }

      if (hit.type === "case-law") {
        await navigate({
          to: "/knowledge/case/$decisionId",
          params: { decisionId: hit.decisionId },
          search: {
            ...(hit.headline && {
              q: extractHighlightedText(hit.headline),
            }),
          },
        });
        return;
      }

      if (hit.type === "matter") {
        await navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: hit.workspaceId },
        });
        return;
      }

      if (hit.type === "document") {
        setRecentFiles(
          recordRecentFile(
            {
              entityId: hit.entityId,
              mimeType: hit.mimeType,
              title: hit.title || hit.id,
              workspaceId: hit.workspaceId,
              workspaceName: hit.workspaceName,
            },
            searchRecentsScope,
          ),
        );
      }

      await navigate({
        to: "/workspaces/$workspaceId/entities/$entityId",
        params: { workspaceId: hit.workspaceId, entityId: hit.entityId },
      });
    },
    [closeSearchDialog, navigate, query, searchRecentsScope],
  );

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, allHits.length - 1));
      } else if (
        e.key === "Escape" &&
        (query.trim() || debouncedQuery.trim() || optimizedSearchQuery)
      ) {
        e.preventDefault();
        e.stopPropagation();
        clearSearchQuery();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Enter" && selectedIndex >= 0) {
        e.preventDefault();
        const hit = allHits[selectedIndex];
        if (hit !== undefined) {
          await handleResultClick(hit);
        }
      }
    },
    [
      allHits,
      clearSearchQuery,
      debouncedQuery,
      optimizedSearchQuery,
      query,
      selectedIndex,
      handleResultClick,
    ],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const hasResults = allHits.length > 0;
  const hasQuery = searchQuery.length > 0;
  const hasTypedQuery =
    query.trim().length > 0 || optimizedSearchQuery !== null;
  const activeFilterCount =
    (filters.types?.length ?? 0) +
    (filters.mimeTypes?.length ?? 0) +
    (filters.workspaceId ? 1 : 0) +
    (filters.editedByUserId ? 1 : 0) +
    (filters.updatedWithin ? 1 : 0);

  useEffect(() => {
    setSummaryState({ status: "idle" });
  }, [
    filterMimeTypesKey,
    filterTypesKey,
    filters.editedByUserId,
    filters.updatedWithin,
    filters.workspaceId,
    searchQuery,
  ]);

  useEffect(() => {
    const root = resultsRef.current;
    const target = loadMoreRef.current;
    if (!hasQuery || !hasNextPage || !root || !target) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(0);
        if (!entry?.isIntersecting || isFetchingNextPage) {
          return;
        }
        void fetchNextPage();
      },
      { root, rootMargin: "160px 0px" },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, hasQuery, isFetchingNextPage]);

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup
        className="flex h-[calc(100dvh-32px)] w-[calc(100vw-16px)] max-w-none flex-col overflow-hidden sm:h-[min(720px,calc(100dvh-96px))] sm:w-[min(960px,calc(100vw-32px))]"
        showCloseButton={false}
      >
        {/* Search input */}
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <SearchIcon className="text-muted-foreground size-5 shrink-0" />
          <Input
            autoFocus
            className="placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm shadow-none outline-none focus-visible:ring-0"
            onChange={handleQueryChange}
            // eslint-disable-next-line typescript/no-misused-promises
            onKeyDown={handleKeyDown}
            placeholder={t("search.placeholder")}
            value={query}
          />
          {isFetching && !isFetchingNextPage && (
            <LoaderIcon className="text-muted-foreground size-4 shrink-0 animate-spin" />
          )}
          <Button
            aria-label={t("search.aiRefine")}
            className="size-8 shrink-0"
            disabled={!query.trim() || isRefiningQuery}
            onClick={() => {
              void handleRefineQuery();
            }}
            size="icon-sm"
            title={t("search.aiRefine")}
            variant="ghost"
          >
            {isRefiningQuery ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <SparklesIcon className="size-4" />
            )}
          </Button>
          <kbd className="bg-muted text-muted-foreground hidden rounded border px-1.5 py-0.5 text-[0.625rem] sm:inline-flex">
            {t("search.escKey")}
          </kbd>
        </div>

        {/* Active filter chips */}
        {(activeFilterCount > 0 || optimizedSearchQuery) && (
          <div className="flex shrink-0 flex-wrap gap-1.5 border-b px-4 py-2">
            {optimizedSearchQuery && (
              <Button
                className="h-auto max-w-full min-w-0 gap-1.5 px-2 py-1 text-xs"
                onClick={showOptimizedSearchQuery}
                size="sm"
                variant="secondary"
              >
                <SparklesIcon className="size-3 shrink-0" />
                <span className="text-muted-foreground shrink-0">
                  {t("search.aiQueryLabel")}
                </span>
                <span className="truncate font-medium">
                  {optimizedSearchQuery.query}
                </span>
              </Button>
            )}
            {filters.workspaceId && (
              <FilterChip
                label={
                  facets?.workspace.find((w) => w.value === filters.workspaceId)
                    ?.label ?? filters.workspaceId
                }
                onRemove={() => setWorkspaceFilter(undefined)}
                type={t("common.matter")}
              />
            )}
            {filters.types?.map((type) => (
              <FilterChip
                key={type}
                label={t(KIND_TRANSLATION_KEYS[type])}
                onRemove={() => removeTypeFilter(type)}
                type={t("common.kind")}
              />
            ))}
            {filters.mimeTypes?.map((mimeType) => (
              <FilterChip
                key={mimeType}
                label={formatMimeTypeLabel(mimeType)}
                onRemove={() => removeMimeTypeFilter(mimeType)}
                type={t("search.mimeType")}
              />
            ))}
            {filters.editedByUserId && (
              <FilterChip
                label={
                  facets?.editor.find(
                    (editor) => editor.value === filters.editedByUserId,
                  )?.label ?? filters.editedByUserId
                }
                onRemove={() => setEditorFilter(undefined)}
                type={t("search.editedBy")}
              />
            )}
            {filters.updatedWithin && (
              <FilterChip
                label={t(
                  UPDATED_WITHIN_TRANSLATION_KEYS[filters.updatedWithin],
                )}
                onRemove={() => setUpdatedWithinFilter(undefined)}
                type={t("search.updatedWithin")}
              />
            )}
          </div>
        )}

        {/* Content area */}
        <div className="flex min-h-0 flex-1">
          {/* Facets sidebar */}
          {hasTypedQuery && hasQuery && facets && (
            <div className="hidden w-56 shrink-0 overflow-y-auto border-e px-3 py-3 sm:block">
              <TimeFacetGroup
                onChange={(value) =>
                  setUpdatedWithinFilter(
                    filters.updatedWithin === value ? undefined : value,
                  )
                }
                selected={filters.updatedWithin}
              />

              {facets.type.length > 0 && (
                <div className="mt-4">
                  <FacetGroup
                    buckets={facets.type.map((bucket) => ({
                      ...bucket,
                      label: isGlobalSearchResultType(bucket.value)
                        ? t(KIND_TRANSLATION_KEYS[bucket.value])
                        : bucket.value,
                    }))}
                    onChange={(value) => {
                      if (isGlobalSearchResultType(value)) {
                        toggleTypeFilter(value);
                      }
                    }}
                    selected={filters.types ?? []}
                    title={t("common.kind")}
                  />
                </div>
              )}

              {facets.mimeType.length > 0 && (
                <div className="mt-4">
                  <FacetGroup
                    buckets={facets.mimeType.map((bucket) => ({
                      ...bucket,
                      label: formatMimeTypeLabel(bucket.value),
                    }))}
                    onChange={toggleMimeTypeFilter}
                    selected={filters.mimeTypes ?? []}
                    title={t("search.mimeType")}
                  />
                </div>
              )}

              {facets.editor.length > 0 && (
                <div className="mt-4">
                  <FacetGroup
                    buckets={facets.editor}
                    onChange={(value) =>
                      setEditorFilter(
                        filters.editedByUserId === value ? undefined : value,
                      )
                    }
                    selected={
                      filters.editedByUserId ? [filters.editedByUserId] : []
                    }
                    title={t("search.editedBy")}
                  />
                </div>
              )}

              {facets.workspace.length > 0 && (
                <div className="mt-4">
                  <p className="text-muted-foreground mb-2 text-xs font-medium">
                    {t("common.matter")}
                  </p>
                  <div className="space-y-0.5">
                    {facets.workspace.map((bucket) => (
                      <Button
                        className={cn(
                          "h-auto w-full justify-between px-2 py-1 text-xs",
                          filters.workspaceId === bucket.value &&
                            "bg-muted font-medium",
                        )}
                        key={bucket.value}
                        onClick={() =>
                          setWorkspaceFilter(
                            filters.workspaceId === bucket.value
                              ? undefined
                              : bucket.value,
                          )
                        }
                        size="sm"
                        variant="ghost"
                      >
                        <span className="truncate">
                          {bucket.label ?? bucket.value}
                        </span>
                        <span className="text-muted-foreground ms-2">
                          {bucket.count}
                        </span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Results */}
          <div className="min-w-0 flex-1 overflow-y-auto" ref={resultsRef}>
            {!hasTypedQuery && (
              <SearchRecents
                onFileClick={openRecentFile}
                onSearchClick={applyRecentSearch}
                recentFiles={recentFiles}
                recentSearches={recentSearches}
              />
            )}

            {hasTypedQuery && !hasResults && (!hasQuery || isLoading) && (
              <div className="space-y-3 px-4 py-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div className="space-y-2" key={`skeleton-${i}`}>
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))}
              </div>
            )}

            {hasTypedQuery && hasQuery && !isLoading && !hasResults && (
              <div className="flex h-full items-center justify-center px-4 py-8">
                <p className="text-muted-foreground text-sm">
                  {t("search.noResults", {
                    query: optimizedSearchQuery?.originalQuery ?? searchQuery,
                  })}
                </p>
              </div>
            )}

            {hasTypedQuery && hasResults && (
              <div className="px-2 py-2">
                <p className="text-muted-foreground px-2 pb-2 text-xs">
                  {t("search.resultCount", {
                    count: totalCount,
                  })}
                </p>
                <SearchSummaryItem
                  isOpeningChat={isOpeningSummaryChat}
                  onCitationClick={(citationId) => {
                    const hit = allHits.find((item) => item.id === citationId);
                    if (hit) {
                      void handleResultClick(hit);
                    }
                  }}
                  onClick={handleSummarizeResults}
                  onOpenChat={handleOpenSummaryChat}
                  state={summaryState}
                />
                {allHits.map((hit, index) => (
                  <SearchResultItem
                    hit={hit}
                    isSelected={index === selectedIndex}
                    key={hit.id}
                    // eslint-disable-next-line typescript/no-misused-promises
                    onClick={handleResultClick}
                    resultNumber={index + 1}
                  />
                ))}
                {hasNextPage && (
                  <div
                    className="flex h-10 items-center justify-center px-2 pt-2"
                    ref={loadMoreRef}
                  >
                    {isFetchingNextPage ? (
                      <LoaderIcon className="text-muted-foreground size-4 animate-spin" />
                    ) : (
                      <span className="sr-only">{t("common.loadMore")}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
};

type SearchSummaryItemProps = {
  state: SearchSummaryState;
  isOpeningChat: boolean;
  onClick: () => void;
  onOpenChat: () => void;
  onCitationClick: (citationId: string) => void;
};

const SearchSummaryItem = ({
  isOpeningChat,
  state,
  onClick,
  onOpenChat,
  onCitationClick,
}: SearchSummaryItemProps) => {
  const t = useTranslations();

  let title = t("search.summaryAction");
  let body = t("search.summaryPrompt");
  if (state.status === "loading") {
    title = t("search.summaryLoading");
    body = t("search.summaryPrompt");
  } else if (state.status === "ready") {
    title = state.title;
    body = state.summary;
  } else if (state.status === "error") {
    title = t("search.summaryError");
    body = state.message ?? t("search.summaryRetry");
  }

  return (
    <div
      className={cn(
        "bg-muted/60 border-primary/30 mb-2 w-full rounded-md border px-2.5 py-2.5 text-start shadow-xs",
        state.status === "ready" && "border-border bg-background",
        state.status === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      {state.status === "ready" ? (
        <div className="flex w-full items-start gap-3 text-start">
          <span className="bg-background text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
            <SparklesIcon className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
            <span className="text-muted-foreground block text-xs font-normal whitespace-pre-line">
              <SummaryBody
                citations={state.citations}
                onCitationClick={onCitationClick}
                text={body}
              />
            </span>
          </span>
        </div>
      ) : (
        <Button
          className="h-auto w-full items-start justify-start gap-3 p-0 text-start whitespace-normal hover:bg-transparent sm:h-auto"
          disabled={state.status === "loading"}
          onClick={onClick}
          variant="ghost"
        >
          <span className="bg-background text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
            {state.status === "loading" ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
            <span className="text-muted-foreground line-clamp-2 text-xs font-normal">
              {body}
            </span>
          </span>
        </Button>
      )}
      {state.status === "ready" && (
        <div className="border-border/70 mt-2 border-t pt-2">
          <Button
            className="h-auto gap-2 px-1.5 py-1 text-xs"
            disabled={isOpeningChat}
            onClick={onOpenChat}
            size="sm"
            variant="ghost"
          >
            {isOpeningChat ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <MessageSquareIcon className="size-3.5" />
            )}
            {t("search.continueInChat")}
          </Button>
        </div>
      )}
    </div>
  );
};

type SummaryBodyProps = {
  text: string;
  citations: Extract<SearchSummaryState, { status: "ready" }>["citations"];
  onCitationClick: (citationId: string) => void;
};

const CITATION_RE = /\[(\d+)\]/gu;

const SummaryBody = ({
  citations,
  onCitationClick,
  text,
}: SummaryBodyProps) => {
  const citationByNumber = new Map(
    citations.map((citation) => [citation.number, citation]),
  );
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CITATION_RE)) {
    const start = match.index ?? 0;
    const numberText = match[1];
    const number = numberText ? Number(numberText) : Number.NaN;
    const citation = citationByNumber.get(number);

    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }

    if (citation) {
      parts.push(
        <button
          className="text-foreground hover:bg-muted mx-0.5 rounded px-1 font-medium"
          key={`${citation.id}-${start}`}
          onClick={(event) => {
            event.stopPropagation();
            onCitationClick(citation.id);
          }}
          title={`${citation.title}\n${citation.reason}`}
          type="button"
        >
          [{citation.number}]
        </button>,
      );
    } else {
      parts.push(match[0]);
    }

    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return <>{parts}</>;
};

type SearchRecentsProps = {
  recentSearches: RecentSearch[];
  recentFiles: RecentFile[];
  onSearchClick: (recent: RecentSearch) => void;
  onFileClick: (file: RecentFile) => Promise<void>;
};

const SearchRecents = ({
  recentSearches,
  recentFiles,
  onSearchClick,
  onFileClick,
}: SearchRecentsProps) => {
  const t = useTranslations();
  const hasRecents = recentSearches.length > 0 || recentFiles.length > 0;

  // TODO: Add scoped quick-create actions.
  if (!hasRecents) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-8">
        <p className="text-muted-foreground text-sm">
          {t("search.emptyState")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-4 py-4">
      {recentSearches.length > 0 && (
        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium">
            {t("search.recentSearches")}
          </h3>
          <div className="space-y-1">
            {recentSearches.map((recent) => (
              <Button
                className="h-auto w-full justify-start gap-2 px-2 py-2 text-start text-sm"
                key={recent.query}
                onClick={() => onSearchClick(recent)}
                variant="ghost"
              >
                <HistoryIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{recent.query}</span>
              </Button>
            ))}
          </div>
        </section>
      )}

      {recentFiles.length > 0 && (
        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium">
            {t("search.recentlyOpenedFiles")}
          </h3>
          <div className="space-y-1">
            {recentFiles.map((file) => (
              <Button
                className="h-auto w-full justify-start gap-2 px-2 py-2 text-start text-sm"
                key={file.entityId}
                onClick={() => {
                  void onFileClick(file);
                }}
                variant="ghost"
              >
                {file.mimeType ? (
                  <DocumentIcon
                    className="text-muted-foreground size-4 shrink-0"
                    mimeType={file.mimeType}
                  />
                ) : (
                  <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{file.title}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {file.workspaceName}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

type FilterChipProps = {
  type: string;
  label: string;
  onRemove: () => void;
};

const FilterChip = ({ type, label, onRemove }: FilterChipProps) => {
  const t = useTranslations();
  return (
    <span className="bg-muted/50 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      <span className="text-muted-foreground">
        {t("search.filterLabel", { type })}
      </span>
      <span className="font-medium">{label}</span>
      <Button
        aria-label={`Remove ${type}: ${label}`}
        className="ms-0.5 size-4 rounded-full"
        onClick={onRemove}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon className="size-3" />
      </Button>
    </span>
  );
};

type FacetGroupProps = {
  title: string;
  buckets: {
    value: string;
    label?: string;
    count: number;
  }[];
  selected: string[];
  onChange: (value: string) => void;
};

type TimeFacetGroupProps = {
  selected: GlobalSearchUpdatedWithin | undefined;
  onChange: (value: GlobalSearchUpdatedWithin) => void;
};

const TimeFacetGroup = ({ selected, onChange }: TimeFacetGroupProps) => {
  const t = useTranslations();

  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs font-medium">
        {t("search.updatedWithin")}
      </p>
      <div className="space-y-0.5">
        {UPDATED_WITHIN_OPTIONS.map((value) => (
          <Button
            className="h-auto w-full justify-start gap-2 px-2 py-1 text-xs"
            key={value}
            onClick={() => onChange(value)}
            size="sm"
            variant="ghost"
          >
            <Checkbox checked={selected === value} tabIndex={-1} />
            <span className="flex-1 truncate text-start">
              {t(UPDATED_WITHIN_TRANSLATION_KEYS[value])}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
};

const FacetGroup = ({
  title,
  buckets,
  selected,
  onChange,
}: FacetGroupProps) => (
  <div>
    <p className="text-muted-foreground mb-2 text-xs font-medium">{title}</p>
    <div className="space-y-0.5">
      {buckets.map((bucket) => (
        <Button
          className="h-auto w-full justify-start gap-2 px-2 py-1 text-xs"
          key={bucket.value}
          onClick={() => onChange(bucket.value)}
          size="sm"
          variant="ghost"
        >
          <Checkbox checked={selected.includes(bucket.value)} tabIndex={-1} />
          <span className="flex-1 truncate text-start">
            {bucket.label ?? bucket.value}
          </span>
          <span className="text-muted-foreground">{bucket.count}</span>
        </Button>
      ))}
    </div>
  </div>
);

type SearchResultItemProps = {
  hit: GlobalSearchHit;
  isSelected?: boolean;
  resultNumber: number;
  onClick: (hit: GlobalSearchHit) => void;
};

const SearchResultItem = ({
  hit,
  isSelected,
  resultNumber,
  onClick,
}: SearchResultItemProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const date = new Date(hit.updatedAt);
  const formatted = new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
  }).format(date);
  let editorMeta: { image: string | null; name: string } | null = null;
  if (hit.type === "document" && hit.lastEditedByName) {
    editorMeta = {
      image: hit.lastEditedByImage,
      name: hit.lastEditedByName,
    };
  }
  let meta: string;
  if (hit.type === "contact") {
    meta = t(KIND_TRANSLATION_KEYS[hit.type]);
  } else if (hit.type === "case-law") {
    meta = "";
  } else if (hit.type === "matter") {
    meta = compactMeta([hit.workspaceName, formatted]);
  } else {
    const lastEditedByName =
      hit.type === "document" ? null : hit.lastEditedByName;
    meta = compactMeta([hit.workspaceName, formatted, lastEditedByName]);
  }

  return (
    <Button
      className={cn(
        "h-auto w-full items-start justify-start gap-3 px-2 py-2 text-start whitespace-normal sm:h-auto",
        isSelected && "bg-accent",
      )}
      data-selected={isSelected || undefined}
      onClick={() => onClick(hit)}
      variant="ghost"
    >
      <SearchHitIcon hit={hit} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{hit.title || hit.id}</p>
        {(meta || editorMeta) && (
          <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
            {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
            {editorMeta ? (
              <>
                {meta ? <span className="shrink-0">·</span> : null}
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <UserAvatar
                    className="size-4 shrink-0 text-[0.5rem]"
                    fallbackClassName="text-[0.5rem]"
                    image={editorMeta.image}
                    name={editorMeta.name}
                  />
                  <span className="truncate">{editorMeta.name}</span>
                </span>
              </>
            ) : null}
          </div>
        )}
        {hit.headline && (
          <p
            className="text-muted-foreground [&_mark]:bg-highlight [&_mark]:text-highlight-foreground mt-0.5 line-clamp-2 text-xs font-normal [&_mark]:font-medium"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: hit.headline,
            }}
          />
        )}
      </div>
      <span className="text-muted-foreground/45 mt-0.5 shrink-0 px-1 text-xs tabular-nums">
        {resultNumber}
      </span>
    </Button>
  );
};

const SearchHitIcon = ({ hit }: { hit: GlobalSearchHit }) => {
  if (hit.type === "document" && hit.mimeType) {
    return (
      <DocumentIcon
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        mimeType={hit.mimeType}
      />
    );
  }

  const Icon = KIND_ICONS[hit.type] ?? FileTextIcon;
  return <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />;
};
