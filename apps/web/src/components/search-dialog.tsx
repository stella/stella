import { useEffect, useMemo, useRef, useState } from "react";

import type { UseMutationResult } from "@tanstack/react-query";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  LayersIcon,
  LandmarkIcon,
  LinkIcon,
  LoaderIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  SquareCheckIcon,
  UserIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useLocale, useTranslations } from "use-intl";

import type {
  EntityKind,
  GlobalSearchHit,
  GlobalSearchResultType,
} from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@stll/ui/components/command";
import { Input } from "@stll/ui/components/input";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { getChatHitRoute } from "@/components/search-dialog.logic";
import { UserAvatar } from "@/components/user-avatar";
import {
  isPublicLawPreviewEnabled,
  usePublicLawPreviewEnabled,
} from "@/hooks/use-public-law-preview";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";
import { toAPIError } from "@/lib/errors";
import { resolveMatterColor } from "@/lib/matter-colors";
import { toSafeId } from "@/lib/safe-id";
import {
  presetUpdatedFrom,
  searchFacetOptions,
  searchInfiniteOptions,
  TIME_PRESETS,
} from "@/lib/search";
import type {
  SearchAISummaryParams,
  SearchableFacet,
  TimePreset,
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
import { stripUndefined } from "@/lib/utils";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

type SearchSummaryCitation = {
  id: string;
  number: number;
  title: string;
  type: string;
  reason: string;
};

type CreateSearchSummaryChatVars = SearchAISummaryParams & {
  title: string;
  summary: string;
  citations: SearchSummaryCitation[];
};

type SearchSummaryData = NonNullable<
  Awaited<ReturnType<typeof api.search.summary.post>>["data"]
>;

const DEBOUNCE_MS = 300;
const VIRTUAL_HIT_ESTIMATE_PX = 76;
const VIRTUAL_HIT_OVERSCAN = 6;

const KIND_ICONS = {
  matter: LayersIcon,
  contact: UserIcon,
  "case-law": LandmarkIcon,
  document: FileTextIcon,
  folder: FolderIcon,
  task: SquareCheckIcon,
  message: MessageSquareIcon,
  link: LinkIcon,
  chat: MessagesSquareIcon,
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
  chat: "search.kinds.chat",
} as const satisfies Record<GlobalSearchResultType, TranslationKey>;

const SEARCH_KIND_TYPES = [
  "matter",
  "contact",
  "case-law",
  "document",
  "folder",
  "task",
  "message",
  "link",
  "chat",
] as const satisfies readonly GlobalSearchResultType[];

const TIME_PRESET_TRANSLATION_KEYS = {
  day: "search.updatedWithinOptions.day",
  week: "search.updatedWithinOptions.week",
  month: "search.updatedWithinOptions.month",
  year: "search.updatedWithinOptions.year",
} as const satisfies Record<TimePreset, TranslationKey>;

const isSearchKindOption = (
  value: string,
): value is (typeof SEARCH_KIND_TYPES)[number] => {
  switch (value) {
    case "matter":
    case "contact":
    case "case-law":
    case "document":
    case "folder":
    case "task":
    case "message":
    case "link":
    case "chat":
      return true;
    default:
      return false;
  }
};

const compactMeta = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .flatMap((part) => {
      const trimmed = part?.trim();
      return trimmed ? [trimmed] : [];
    })
    .join(" · ");

const isAvailableSearchKind = (
  type: GlobalSearchResultType,
  includePublicLaw: boolean,
): boolean => type !== "case-law" || includePublicLaw;

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

const isoToDateInputValue = (iso: string): string => iso.slice(0, 10);

const dateInputToIsoStart = (value: string): string =>
  new Date(`${value}T00:00:00.000Z`).toISOString();

const dateInputToIsoEnd = (value: string): string =>
  new Date(`${value}T23:59:59.999Z`).toISOString();

const mergeSelectedBuckets = (
  buckets: { value: string; label?: string; count: number }[],
  selected: string[],
  getLabel: (value: string) => string,
): { value: string; label?: string; count: number }[] => {
  const present = new Set(buckets.map((bucket) => bucket.value));
  const missing = selected
    .filter((value) => !present.has(value))
    .map((value) => ({ value, label: getLabel(value), count: 0 }));
  return [...buckets, ...missing];
};

type TimeFilter =
  | { mode: "preset"; preset: TimePreset }
  | { mode: "custom"; updatedFrom?: string; updatedTo?: string };

type SearchFilters = {
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  editedByUserIds: string[];
  mimeTypes: string[];
  time?: TimeFilter;
};

const filterUpdatedTo = (filters: SearchFilters): string | undefined =>
  filters.time?.mode === "custom" ? filters.time.updatedTo : undefined;

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
  const user = useAuthenticatedUser();
  const publicLawPreviewEnabled = usePublicLawPreviewEnabled();
  const searchRecentsScope = useMemo(
    (): SearchRecentsScope => ({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }),
    [user.activeOrganizationId, user.id],
  );
  const [resultsElement, setResultsElement] = useState<HTMLDivElement | null>(
    null,
  );
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({
    editedByUserIds: [],
    mimeTypes: [],
    types: [],
    workspaceIds: initialWorkspaceId ? [initialWorkspaceId] : [],
  });

  const debouncedSetQuery = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
  }, DEBOUNCE_MS);

  const searchQuery = debouncedQuery;
  // Resolve preset → ISO once per logical search. Memoising on
  // [filters.time, searchQuery] gives us a fresh `now() - duration`
  // whenever the user picks a new preset or runs a new query, while
  // staying stable across pagination so `fetchNextPage` keeps using
  // the same cutoff as page 1.
  const updatedFrom = useMemo(() => {
    if (filters.time?.mode === "preset") {
      return presetUpdatedFrom(filters.time.preset);
    }
    if (filters.time?.mode === "custom") {
      return filters.time.updatedFrom;
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: include searchQuery so each new query gets a fresh preset cutoff
  }, [filters.time, searchQuery]);
  const updatedTo = filterUpdatedTo(filters);
  const selectedSearchTypes = filters.types.filter(
    (type) =>
      isSearchKindOption(type) &&
      isAvailableSearchKind(type, publicLawPreviewEnabled),
  );
  const activeSearchTypes =
    selectedSearchTypes.length > 0
      ? selectedSearchTypes
      : SEARCH_KIND_TYPES.filter((type) =>
          isAvailableSearchKind(type, publicLawPreviewEnabled),
        );

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
      workspaceIds: filters.workspaceIds,
      kinds: [],
      types: activeSearchTypes,
      editedByUserIds: filters.editedByUserIds,
      mimeTypes: filters.mimeTypes,
      updatedFrom,
      updatedTo,
    }),
  );

  const allHits = useMemo(
    () => data?.pages.flatMap((page) => page.hits) ?? [],
    [data?.pages],
  );
  const getHitVirtualKey = (index: number) => allHits.at(index)?.id ?? index;

  // Counts and facets are computed only on the first page (see backend);
  // ignore them entirely while the query is empty so a cleared input
  // doesn't leave stale numbers in the sidebar.
  const firstPage = searchQuery.length > 0 ? data?.pages.at(0) : undefined;
  const facets = firstPage?.facets;
  const totalCount = firstPage?.totalCount ?? 0;
  const filterTypesKey = filters.types.join("|");
  const filterMimeTypesKey = filters.mimeTypes.join("|");
  const filterWorkspaceIdsKey = filters.workspaceIds.join("|");

  const hitVirtualizer = useVirtualizer({
    count: allHits.length,
    enabled: open && resultsElement !== null,
    estimateSize: () => VIRTUAL_HIT_ESTIMATE_PX,
    getItemKey: getHitVirtualKey,
    getScrollElement: () => resultsElement,
    overscan: VIRTUAL_HIT_OVERSCAN,
  });
  const virtualHits = hitVirtualizer.getVirtualItems();

  useEffect(() => {
    if (!open) {
      return;
    }
    setRecentSearches(readRecentSearches(searchRecentsScope));
    setRecentFiles(readRecentFiles(searchRecentsScope));
  }, [open, searchRecentsScope]);

  const searchFilterParams = {
    workspaceIds: filters.workspaceIds,
    types: activeSearchTypes,
    editedByUserIds: filters.editedByUserIds,
    mimeTypes: filters.mimeTypes,
    updatedFrom,
    updatedTo,
  };

  const facetSearchParams = {
    query: searchQuery,
    kinds: [] satisfies EntityKind[],
    ...searchFilterParams,
  };

  const analytics = useAnalytics();

  const summarizeSearchMutation = useMutation({
    mutationFn: async (params: SearchAISummaryParams) => {
      const response = await api.search.summary.post(
        stripUndefined({
          query: params.query,
          locale: params.locale,
          originalQuery: params.originalQuery,
          workspaceIds: params.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          types: params.types,
          editedByUserIds: params.editedByUserIds,
          mimeTypes: params.mimeTypes,
          updatedFrom: params.updatedFrom,
          updatedTo: params.updatedTo,
          limit: params.limit,
        }),
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const refineSearchMutation = useMutation({
    mutationFn: async (vars: { query: string; locale: string }) => {
      const response = await api.search.refine.post({
        query: vars.query,
        locale: vars.locale,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const createSummaryChatMutation = useMutation({
    mutationFn: async (vars: CreateSearchSummaryChatVars) => {
      const response = await api.search.summary.chat.post(
        stripUndefined({
          query: vars.query,
          title: vars.title,
          summary: vars.summary,
          citations: vars.citations.map((citation) => ({
            number: citation.number,
          })),
          originalQuery: vars.originalQuery,
          workspaceIds: vars.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          types: vars.types,
          editedByUserIds: vars.editedByUserIds,
          mimeTypes: vars.mimeTypes,
          updatedFrom: vars.updatedFrom,
          updatedTo: vars.updatedTo,
          limit: vars.limit,
        }),
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const clearSearchQuery = () => {
    debouncedSetQuery.cancel();
    setQuery("");
    setDebouncedQuery("");
    summarizeSearchMutation.reset();
  };

  const handleEscapeAction = () => {
    if (query.trim() || debouncedQuery.trim()) {
      clearSearchQuery();
      return;
    }
    onOpenChange(false);
  };

  const handleSummarizeResults = () => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery || summarizeSearchMutation.isPending) {
      return;
    }

    summarizeSearchMutation.mutate({
      query: trimmedQuery,
      locale,
      ...searchFilterParams,
      limit: 5,
    });
  };

  const handleOpenSummaryChat = () => {
    const trimmedQuery = searchQuery.trim();
    const summaryData = summarizeSearchMutation.data;
    if (
      !summarizeSearchMutation.isSuccess ||
      summaryData === undefined ||
      !trimmedQuery ||
      createSummaryChatMutation.isPending
    ) {
      return;
    }

    createSummaryChatMutation.mutate(
      {
        query: trimmedQuery,
        locale,
        title: summaryData.title,
        summary: summaryData.summary,
        citations: summaryData.citations,
        ...searchFilterParams,
        limit: 5,
      },
      {
        onSuccess: (thread) => {
          onOpenChange(false);
          void navigate({
            to: "/chat/$threadId",
            params: { threadId: thread.threadId },
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
        },
      },
    );
  };

  const handleRefineQuery = () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || refineSearchMutation.isPending) {
      return;
    }

    refineSearchMutation.mutate(
      { query: trimmedQuery, locale },
      {
        onSuccess: (refined, variables) => {
          debouncedSetQuery.cancel();
          setQuery(refined.query);
          setDebouncedQuery(refined.query);
          summarizeSearchMutation.reset();
          setRecentSearches(
            recordRecentSearch(variables.query, searchRecentsScope),
          );
        },
        onError: () => {
          stellaToast.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
        },
      },
    );
  };

  const applyRecentSearch = (recent: RecentSearch) => {
    setQuery(recent.query);
    setDebouncedQuery(recent.query);
    summarizeSearchMutation.reset();
    setRecentSearches(recordRecentSearch(recent.query, searchRecentsScope));
  };

  const openRecentFile = async (file: RecentFile) => {
    onOpenChange(false);
    setRecentFiles(recordRecentFile(file, searchRecentsScope));
    await navigate({
      to: "/workspaces/$workspaceId/entities/$entityId",
      params: { workspaceId: file.workspaceId, entityId: file.entityId },
    });
  };

  const toggleTypeFilter = (type: GlobalSearchResultType) => {
    setFilters((prev) => {
      const next = prev.types.includes(type)
        ? prev.types.filter((item) => item !== type)
        : [...prev.types, type];
      return {
        ...prev,
        types: next,
      };
    });
  };

  const toggleWorkspaceFilter = (workspaceId: string) => {
    setFilters((prev) => {
      const next = prev.workspaceIds.includes(workspaceId)
        ? prev.workspaceIds.filter((id) => id !== workspaceId)
        : [...prev.workspaceIds, workspaceId];
      return { ...prev, workspaceIds: next };
    });
  };

  const toggleEditorFilter = (editorId: string) => {
    setFilters((prev) => {
      const next = prev.editedByUserIds.includes(editorId)
        ? prev.editedByUserIds.filter((id) => id !== editorId)
        : [...prev.editedByUserIds, editorId];
      return {
        ...prev,
        editedByUserIds: next,
      };
    });
  };

  const setTimePreset = (preset: TimePreset | undefined) => {
    setFilters((prev): SearchFilters => {
      const { time: _, ...rest } = prev;
      if (!preset) {
        return rest;
      }
      return { ...rest, time: { mode: "preset", preset } };
    });
  };

  const setCustomDateRange = (range: {
    updatedFrom?: string;
    updatedTo?: string;
  }) => {
    setFilters((prev): SearchFilters => {
      const { time: _, ...rest } = prev;
      return {
        ...rest,
        time: {
          mode: "custom",
          ...(range.updatedFrom !== undefined && {
            updatedFrom: range.updatedFrom,
          }),
          ...(range.updatedTo !== undefined && {
            updatedTo: range.updatedTo,
          }),
        },
      };
    });
  };

  const clearTimeFilter = () => {
    setFilters((prev): SearchFilters => {
      const { time: _, ...rest } = prev;
      return rest;
    });
  };

  const toggleMimeTypeFilter = (mimeType: string) => {
    setFilters((prev) => {
      const next = prev.mimeTypes.includes(mimeType)
        ? prev.mimeTypes.filter((item) => item !== mimeType)
        : [...prev.mimeTypes, mimeType];
      return {
        ...prev,
        mimeTypes: next,
      };
    });
  };

  const handleResultClick = async (hit: GlobalSearchHit) => {
    if (query.trim()) {
      setRecentSearches(recordRecentSearch(query, searchRecentsScope));
    }

    onOpenChange(false);
    if (hit.type === "contact") {
      await navigate({
        to: "/contacts/$contactId",
        params: { contactId: hit.contactId },
      });
      return;
    }

    if (hit.type === "case-law") {
      if (!isPublicLawPreviewEnabled()) {
        stellaToast.add({
          title: t("common.comingSoon"),
          type: "neutral",
        });
        return;
      }

      const slug =
        "slug" in hit && typeof hit.slug === "string" ? hit.slug : null;
      await navigate({
        to: "/law/$country/cases/$court/$date/$slug",
        params: createCaseLawDecisionRouteParams({
          caseNumber: hit.caseNumber,
          country: hit.country,
          court: hit.court,
          decisionDate: hit.decisionDate,
          decisionId: hit.decisionId,
          slug,
        }),
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

    if (hit.type === "chat") {
      await navigate(getChatHitRoute(hit));
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
  };

  const handleCommandInputKeyDownCapture = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Escape" && (query.trim() || debouncedQuery.trim())) {
      e.preventDefault();
      e.stopPropagation();
      handleEscapeAction();
    }
  };

  const hasResults = allHits.length > 0;
  const hasQuery = searchQuery.length > 0;
  const hasTypedQuery = query.trim().length > 0;
  const commandHits = hasTypedQuery && hasResults ? allHits : [];
  const filterEditorIdsKey = filters.editedByUserIds.join("|");

  useEffect(() => {
    summarizeSearchMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset is the stable mutation method needed here
  }, [
    filterEditorIdsKey,
    filterMimeTypesKey,
    filterTypesKey,
    filterWorkspaceIdsKey,
    filters.time,
    summarizeSearchMutation.reset,
    searchQuery,
  ]);

  useEffect(() => {
    const root = resultsElement;
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
  }, [
    fetchNextPage,
    hasNextPage,
    hasQuery,
    isFetchingNextPage,
    resultsElement,
  ]);

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
      <CommandDialogPopup
        className="flex h-[calc(100dvh-32px)] w-[calc(100vw-16px)] max-w-none flex-col overflow-hidden sm:h-[min(720px,calc(100dvh-96px))] sm:w-[min(960px,calc(100vw-32px))]"
        showCloseButton={false}
      >
        <Command
          itemToStringValue={(hit) => hit.title}
          items={commandHits}
          keepHighlight={false}
          mode="none"
          onItemHighlighted={(_, eventDetails) => {
            if (eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
              return;
            }
            hitVirtualizer.scrollToIndex(eventDetails.index, { align: "auto" });
          }}
          onValueChange={(value, eventDetails) => {
            if (eventDetails.reason === "item-press") {
              return;
            }
            setQuery(value);
            debouncedSetQuery(value);
            summarizeSearchMutation.reset();
          }}
          value={query}
          virtualized
        >
          {/* Search input */}
          <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
            <CommandInput
              autoFocus
              className="text-sm"
              onKeyDownCapture={handleCommandInputKeyDownCapture}
              placeholder={t("search.placeholder")}
            />
            {isFetching && !isFetchingNextPage && (
              <LoaderIcon className="text-muted-foreground size-4 shrink-0 animate-spin" />
            )}
            <Button
              aria-label={t("search.aiRefine")}
              className="size-8 shrink-0"
              disabled={!query.trim() || refineSearchMutation.isPending}
              onClick={() => {
                handleRefineQuery();
              }}
              size="icon-sm"
              title={t("search.aiRefine")}
              variant="ghost"
            >
              {refineSearchMutation.isPending ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <WandSparklesIcon className="size-4" />
              )}
            </Button>
            <Button
              aria-keyshortcuts="Escape"
              aria-label={t("search.escKey")}
              className="border-border bg-muted text-muted-foreground hover:bg-muted/80 hidden h-auto rounded border px-1.5 py-0.5 text-[0.625rem] leading-none sm:inline-flex"
              onClick={handleEscapeAction}
              title={t("search.escKey")}
              variant="ghost"
            >
              {t("search.escKey")}
            </Button>
          </div>

          {/* Content area */}
          <div className="flex min-h-0 flex-1">
            {/* Facets sidebar — always present so the layout stays stable. */}
            <div className="hidden w-56 shrink-0 overflow-y-auto border-e px-3 py-3 sm:block">
              <TimeFacetGroup
                locale={locale}
                onClearCustom={clearTimeFilter}
                onPresetChange={(preset) =>
                  setTimePreset(
                    filters.time?.mode === "preset" &&
                      filters.time.preset === preset
                      ? undefined
                      : preset,
                  )
                }
                onCustomChange={setCustomDateRange}
                time={filters.time}
              />

              {hasQuery && (
                <>
                  {(facets?.type.length ?? 0) + filters.types.length > 0 && (
                    <div className="mt-4">
                      <FacetGroup
                        buckets={mergeSelectedBuckets(
                          (facets?.type ?? []).flatMap((bucket) => {
                            if (!isSearchKindOption(bucket.value)) {
                              return [];
                            }
                            if (
                              !isAvailableSearchKind(
                                bucket.value,
                                publicLawPreviewEnabled,
                              )
                            ) {
                              return [];
                            }
                            return [
                              {
                                value: bucket.value,
                                count: bucket.count,
                                label: t(KIND_TRANSLATION_KEYS[bucket.value]),
                              },
                            ];
                          }),
                          filters.types,
                          (value) =>
                            isSearchKindOption(value)
                              ? t(KIND_TRANSLATION_KEYS[value])
                              : value,
                        )}
                        onChange={(value) => {
                          if (isSearchKindOption(value)) {
                            toggleTypeFilter(value);
                          }
                        }}
                        selected={filters.types}
                        title={t("common.kind")}
                      />
                    </div>
                  )}

                  <div className="mt-4">
                    <SearchableFacetGroup
                      defaultBuckets={facets?.mimeType ?? []}
                      facet="mimeType"
                      formatLabel={(bucket) =>
                        formatMimeTypeLabel(bucket.value)
                      }
                      onChange={toggleMimeTypeFilter}
                      searchParams={facetSearchParams}
                      selected={filters.mimeTypes}
                      title={t("search.mimeType")}
                    />
                  </div>

                  <div className="mt-4">
                    <SearchableFacetGroup
                      defaultBuckets={facets?.editor ?? []}
                      facet="editor"
                      onChange={toggleEditorFilter}
                      searchParams={facetSearchParams}
                      selected={filters.editedByUserIds}
                      title={t("search.editedBy")}
                    />
                  </div>

                  <div className="mt-4">
                    <SearchableFacetGroup
                      defaultBuckets={facets?.workspace ?? []}
                      facet="workspace"
                      onChange={toggleWorkspaceFilter}
                      searchParams={facetSearchParams}
                      selected={filters.workspaceIds}
                      title={t("common.matter")}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Results */}
            <CommandList
              className="max-h-none min-w-0 flex-1 overflow-y-auto"
              ref={setResultsElement}
            >
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
                      query: searchQuery,
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
                    isOpeningChat={createSummaryChatMutation.isPending}
                    onCitationClick={(citationId) => {
                      const hit = allHits.find(
                        (item) => item.id === citationId,
                      );
                      if (hit) {
                        void handleResultClick(hit);
                      }
                    }}
                    onClick={() => {
                      handleSummarizeResults();
                    }}
                    onOpenChat={() => {
                      handleOpenSummaryChat();
                    }}
                    summarizeMutation={summarizeSearchMutation}
                  />
                  <div
                    className="relative"
                    style={{ height: `${hitVirtualizer.getTotalSize()}px` }}
                  >
                    {virtualHits.map((virtualHit) => {
                      const hit = allHits.at(virtualHit.index);
                      if (!hit) {
                        return null;
                      }
                      return (
                        <div
                          className="absolute inset-x-0 top-0"
                          data-index={virtualHit.index}
                          key={hit.id}
                          ref={hitVirtualizer.measureElement}
                          style={{
                            transform: `translateY(${virtualHit.start}px)`,
                          }}
                        >
                          <SearchResultItem
                            hit={hit}
                            index={virtualHit.index}
                            onClick={(selectedHit) => {
                              void handleResultClick(selectedHit);
                            }}
                            resultNumber={virtualHit.index + 1}
                          />
                        </div>
                      );
                    })}
                  </div>
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
            </CommandList>
          </div>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
};

type SearchSummaryItemProps = {
  summarizeMutation: UseMutationResult<
    SearchSummaryData,
    Error,
    SearchAISummaryParams
  >;
  isOpeningChat: boolean;
  onClick: () => void;
  onOpenChat: () => void;
  onCitationClick: (citationId: string) => void;
};

const SearchSummaryItem = ({
  isOpeningChat,
  summarizeMutation,
  onClick,
  onOpenChat,
  onCitationClick,
}: SearchSummaryItemProps) => {
  const t = useTranslations();

  const { isPending, isError, isSuccess, data } = summarizeMutation;

  if (!isSuccess) {
    let title = t("search.summaryAction");
    let body = t("search.summaryPrompt");
    if (isPending) {
      title = t("search.summaryLoading");
    } else if (isError) {
      title = t("search.summaryError");
      body = t("search.summaryRetry");
    }

    return (
      <Button
        className="mb-2 h-auto w-full items-start justify-start gap-3 rounded-md px-2.5 py-2.5 text-start whitespace-normal sm:h-auto"
        disabled={isPending}
        onClick={onClick}
        variant={isError ? "destructive-outline" : "outline"}
      >
        <span className="bg-background text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
          {isPending ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <WandSparklesIcon className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="text-muted-foreground line-clamp-2 text-xs font-normal">
            {body}
          </span>
        </span>
      </Button>
    );
  }

  return (
    <div className="border-border bg-background mb-2 w-full rounded-md border px-2.5 py-2.5 text-start shadow-xs">
      <div className="flex w-full items-start gap-3 text-start">
        <span className="bg-background text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
          <WandSparklesIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {data.title}
          </span>
          <span className="text-muted-foreground block text-xs font-normal whitespace-pre-line">
            <SummaryBody
              citations={data.citations}
              onCitationClick={onCitationClick}
              text={data.summary}
            />
          </span>
        </span>
      </div>
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
    </div>
  );
};

type SummaryBodyProps = {
  text: string;
  citations: SearchSummaryData["citations"];
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
    const start = match.index;
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
          <div className="flex flex-col gap-y-1">
            {recentFiles.map((file) => (
              <Button
                className="h-auto! w-full justify-start gap-2 py-1 text-start text-sm"
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
  time: TimeFilter | undefined;
  locale: string;
  onPresetChange: (preset: TimePreset) => void;
  onCustomChange: (range: { updatedFrom?: string; updatedTo?: string }) => void;
  onClearCustom: () => void;
};

const TimeFacetGroup = ({
  time,
  locale,
  onPresetChange,
  onCustomChange,
  onClearCustom,
}: TimeFacetGroupProps) => {
  const t = useTranslations();
  const isCustom = time?.mode === "custom";
  const customFromValue =
    time?.mode === "custom" && time.updatedFrom
      ? isoToDateInputValue(time.updatedFrom)
      : null;
  const customToValue =
    time?.mode === "custom" && time.updatedTo
      ? isoToDateInputValue(time.updatedTo)
      : null;

  const handleFromChange = (value: string | null) => {
    if (!value) {
      if (!customToValue) {
        onClearCustom();
        return;
      }
      onCustomChange({ updatedTo: dateInputToIsoEnd(customToValue) });
      return;
    }
    onCustomChange({
      updatedFrom: dateInputToIsoStart(value),
      ...(customToValue && { updatedTo: dateInputToIsoEnd(customToValue) }),
    });
  };

  const handleToChange = (value: string | null) => {
    if (!value) {
      if (!customFromValue) {
        onClearCustom();
        return;
      }
      onCustomChange({ updatedFrom: dateInputToIsoStart(customFromValue) });
      return;
    }
    onCustomChange({
      ...(customFromValue && {
        updatedFrom: dateInputToIsoStart(customFromValue),
      }),
      updatedTo: dateInputToIsoEnd(value),
    });
  };

  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs font-medium">
        {t("search.updatedWithin")}
      </p>
      <div className="space-y-0.5">
        {TIME_PRESETS.map((preset) => {
          const isActive = time?.mode === "preset" && time.preset === preset;
          return (
            <Button
              className="h-auto w-full justify-start gap-2 px-2 py-1 text-xs"
              key={preset}
              onClick={() => onPresetChange(preset)}
              size="sm"
              variant="ghost"
            >
              <Checkbox checked={isActive} tabIndex={-1} />
              <span className="flex-1 truncate text-start">
                {t(TIME_PRESET_TRANSLATION_KEYS[preset])}
              </span>
            </Button>
          );
        })}
        <Button
          className="h-auto w-full justify-start gap-2 px-2 py-1 text-xs"
          onClick={() => {
            if (isCustom) {
              onClearCustom();
            } else {
              onCustomChange({});
            }
          }}
          size="sm"
          variant="ghost"
        >
          <Checkbox checked={isCustom} tabIndex={-1} />
          <span className="flex-1 truncate text-start">
            {t("search.timeFilterCustom")}
          </span>
        </Button>
      </div>
      {isCustom && (
        <div className="mt-2 space-y-1 px-2">
          <div>
            <p className="text-muted-foreground text-[0.625rem] font-medium tracking-wide uppercase">
              {t("search.dateFrom")}
            </p>
            <DatePickerPopover
              locale={locale}
              onChange={handleFromChange}
              value={customFromValue}
              {...(customToValue !== null && { maxDate: customToValue })}
            />
          </div>
          <div>
            <p className="text-muted-foreground text-[0.625rem] font-medium tracking-wide uppercase">
              {t("search.dateTo")}
            </p>
            <DatePickerPopover
              locale={locale}
              onChange={handleToChange}
              value={customToValue}
              {...(customFromValue !== null && { minDate: customFromValue })}
            />
          </div>
        </div>
      )}
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
    <FacetBucketList
      buckets={buckets}
      onChange={onChange}
      selected={selected}
    />
  </div>
);

type FacetBucket = { value: string; label?: string; count: number };

type FacetBucketListProps = {
  buckets: FacetBucket[];
  selected: string[];
  onChange: (value: string) => void;
};

const FacetBucketList = ({
  buckets,
  selected,
  onChange,
}: FacetBucketListProps) => (
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
        <span className="text-muted-foreground tabular-nums">
          {bucket.count}
        </span>
      </Button>
    ))}
  </div>
);

const FACET_SEARCH_DEBOUNCE_MS = 250;
const FACET_SEARCH_LIMIT = 20;

type SearchableFacetGroupProps = {
  facet: SearchableFacet;
  title: string;
  defaultBuckets: FacetBucket[];
  selected: string[];
  onChange: (value: string) => void;
  searchParams: {
    query: string;
    workspaceIds: string[];
    types: GlobalSearchResultType[];
    kinds: EntityKind[];
    editedByUserIds: string[];
    mimeTypes: string[];
    updatedFrom?: string | undefined;
    updatedTo?: string | undefined;
  };
  formatLabel?: (bucket: FacetBucket) => string;
};

const SearchableFacetGroup = ({
  facet,
  title,
  defaultBuckets,
  selected,
  onChange,
  searchParams,
  formatLabel,
}: SearchableFacetGroupProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debouncedSetSearch = useDebouncedCallback(
    setDebouncedSearch,
    FACET_SEARCH_DEBOUNCE_MS,
  );
  const labelCacheRef = useRef<Record<string, string>>({});
  const isSearching = debouncedSearch.trim().length > 0;

  const { data: searchData } = useQuery({
    ...searchFacetOptions({
      facet,
      search: debouncedSearch,
      limit: FACET_SEARCH_LIMIT,
      ...searchParams,
    }),
    enabled: isSearching && searchParams.query.length > 0,
  });

  const resolveLabel = (bucket: FacetBucket): string =>
    formatLabel ? formatLabel(bucket) : (bucket.label ?? bucket.value);

  // Refs are intentionally mutated during render — they don't trigger
  // re-renders, and we want every label seen in the current render's
  // buckets to be available when computing `buckets` below.
  for (const bucket of defaultBuckets) {
    labelCacheRef.current[bucket.value] = resolveLabel(bucket);
  }
  for (const bucket of searchData?.buckets ?? []) {
    labelCacheRef.current[bucket.value] = resolveLabel(bucket);
  }

  const sourceBuckets =
    isSearching && searchData ? searchData.buckets : defaultBuckets;

  const visible: FacetBucket[] = sourceBuckets.map((bucket) => ({
    value: bucket.value,
    count: bucket.count,
    label: resolveLabel(bucket),
  }));
  const present = new Set(visible.map((bucket) => bucket.value));
  const missingSelected: FacetBucket[] = selected
    .filter((id) => !present.has(id))
    .map((id) => ({
      value: id,
      label: labelCacheRef.current[id] ?? id,
      count: 0,
    }));
  const buckets: FacetBucket[] = [...visible, ...missingSelected];

  if (buckets.length === 0 && !isSearching && searchData === undefined) {
    return null;
  }

  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs font-medium">{title}</p>
      <Input
        className="mb-1.5 h-7 px-2 text-xs"
        onChange={(e) => {
          const value = e.target.value;
          setSearch(value);
          debouncedSetSearch(value);
        }}
        placeholder={t("common.search")}
        value={search}
      />
      <FacetBucketList
        buckets={buckets}
        onChange={onChange}
        selected={selected}
      />
    </div>
  );
};

type SearchResultItemProps = {
  hit: GlobalSearchHit;
  index: number;
  resultNumber: number;
  onClick: (hit: GlobalSearchHit) => void;
};

const SearchResultItem = ({
  hit,
  index,
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
  } else if (hit.type === "chat") {
    meta = compactMeta([hit.workspaceName, formatted]);
  } else {
    const lastEditedByName =
      hit.type === "document" ? null : hit.lastEditedByName;
    meta = compactMeta([hit.workspaceName, formatted, lastEditedByName]);
  }

  return (
    <CommandItem
      className="h-auto w-full items-start justify-start gap-3 px-2 py-2 text-start whitespace-normal sm:h-auto"
      index={index}
      onClick={() => onClick(hit)}
      value={hit}
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
            dangerouslySetInnerHTML={{
              __html: hit.headline,
            }}
          />
        )}
      </div>
      <span className="text-foreground-subtle mt-0.5 shrink-0 px-1 text-xs tabular-nums">
        {resultNumber}
      </span>
    </CommandItem>
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

  const Icon = KIND_ICONS[hit.type];

  if (hit.type === "matter") {
    const color = resolveMatterColor(hit.workspaceId, hit.color);
    return <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} />;
  }

  return <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />;
};
