import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ComponentProps,
  CSSProperties,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  SetStateAction,
} from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import { LoaderIcon, PanelRightIcon, WandSparklesIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { GLOBAL_SEARCH_RESULT_TYPES } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandInput,
  CommandList,
} from "@stll/ui/command";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { contentDir } from "@stll/ui/use-content-dir";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { RenderStormRegion } from "@/components/render-storm-canary";
import { SavedSearches } from "@/components/saved-searches";
import {
  toSearchFilters,
  type SavedSearchCriteria,
} from "@/components/saved-searches.logic";
import {
  SearchColumnResizeHandle,
  SearchFooterHint,
  SearchFooterHintText,
} from "@/components/search-dialog-controls";
import {
  FacetGroup,
  SearchableFacetGroup,
  TimeFacetGroup,
} from "@/components/search-dialog-facets";
import {
  RecentFilePreviewPanel,
  SearchPreviewPanel,
} from "@/components/search-dialog-preview";
import {
  CommandActionItem,
  SearchRecents,
  SearchResultItem,
  SearchSummaryItem,
} from "@/components/search-dialog-results";
import {
  canUseAskAIShortcut,
  createDialogCloseActionQueue,
  getChatHitRoute,
  getEntityLocationRoute,
  getEntityWorkspaceRoute,
  getRecentFileRoute,
  resolveEntityDocumentRoute,
  toAskAIMessageHtml,
} from "@/components/search-dialog.logic";
import {
  EMPTY_FACET_BUCKETS,
  EMPTY_SEARCH_HITS,
  EMPTY_SEARCH_PREVIEW_LOCATOR_CANDIDATES,
  formatMimeTypeLabel,
  initialSearchFilters,
  isAvailableSearchKind,
  isSearchKindOption,
  KIND_TRANSLATION_KEYS,
  mergeSelectedBuckets,
  SEARCH_PREVIEW_COLUMN_CLASS_NAME,
} from "@/components/search-dialog.shared";
import {
  canShowSearchSummary,
  clearTime,
  enforceDocumentPickFilters,
  hasUnavailableSearchType,
  resolveActiveSearchTypes,
  resolveUpdatedFrom,
  resolveUpdatedTo,
  setCustomTime,
  setPresetTime,
  toggleArrayMember,
} from "@/components/search-filters.logic";
import type { SearchFilters } from "@/components/search-filters.logic";
import { useChatUserContext } from "@/features/chat/hooks/use-chat-user-context";
import { startNewThreadCommandHandoff } from "@/features/chat/lib/start-new-thread-command-handoff";
import { invalidateGroupedChatThreads } from "@/features/chat/queries";
import { useCommandActions } from "@/features/command-palette/hooks/use-command-actions";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import {
  isPublicLawPreviewEnabled,
  usePublicLawPreviewEnabled,
} from "@/hooks/use-public-law-preview";
import { useLocale } from "@/i18n/formatting-context";
import { useI18nStore } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { GlobalSearchHit } from "@/lib/api-contract";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";
import { getChatSendMode } from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { FILE_OPEN_TARGET, resolveFileOpenTarget } from "@/lib/file-open.logic";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { toSafeId } from "@/lib/safe-id";
import {
  hasSearchQueryOrSelectiveFilter,
  recentFilePreviewFieldOptions,
  searchInfiniteOptions,
} from "@/lib/search";
import type { SearchAISummaryParams } from "@/lib/search";
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
import {
  getFirstSearchHighlightText,
  selectDisplayedSearchPreviewHit,
  selectSearchPreviewHit,
  shouldShowSearchPreview,
} from "@/lib/search.logic";

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

const DEBOUNCE_MS = 300;
const PREVIEW_HIGHLIGHT_DEBOUNCE_MS = 180;
const VIRTUAL_HIT_ESTIMATE_PX = 76;
const VIRTUAL_HIT_OVERSCAN = 6;
// Draggable column bounds (px). The results column keeps a readable floor so
// neither divider can crush it.
const SEARCH_FACETS_DEFAULT_WIDTH = 224;
const SEARCH_FACETS_MIN_WIDTH = 176;
const SEARCH_FACETS_MAX_WIDTH = 400;
const SEARCH_PREVIEW_MIN_WIDTH = 288;
const SEARCH_PREVIEW_MAX_WIDTH = 800;
/** Nominal width of the preview column before the user drags it — the
 * 32rem arm of the CSS default `min(44%, 32rem)`; used for the
 * separator's reported value until a drag pins an explicit width. */
const SEARCH_PREVIEW_DEFAULT_WIDTH = 512;
const SEARCH_RESULTS_MIN_WIDTH = 320;

/** A document chosen in pick mode, resolved to the file field the caller can
 *  pin: the hit's own when it names one, else the entity's current file. */
export type PickedSearchDocument = {
  workspaceId: string;
  /** `null` when the index carries no matter name for the hit. */
  workspaceName: string | null;
  entityId: string;
  fileFieldId: string;
  name: string;
};

/**
 * What activating a result does. `browse` navigates to it; `pick` hands a
 * document back to the caller instead, so another surface (a reference
 * picker) can reuse the whole search without navigating away.
 */
export type SearchDialogMode =
  | { type: "browse" }
  | {
      type: "pick";
      /** Only documents of these MIME types are offered and accepted. */
      mimeTypes: readonly string[];
      /** Documents that must not appear at all: the one being reviewed and
       *  those already chosen. */
      excludeEntityIds: readonly string[];
      onPick: (document: PickedSearchDocument) => void;
    };

const BROWSE_MODE: SearchDialogMode = { type: "browse" };

// English until the picker copy settles; then it joins the catalog.
const PICK_HINT_LABEL = "add as reference";
const PICK_MODE_LABEL =
  "Click a document to select it as a reference. The reviewed document is not listed.";
const NO_EXCLUDED_ENTITY_IDS: readonly string[] = [];

const initialFiltersForMode = (
  mode: SearchDialogMode,
  initialWorkspaceId: string | undefined,
): SearchFilters => {
  const filters = initialSearchFilters(initialWorkspaceId);
  if (mode.type === "pick") {
    return enforceDocumentPickFilters(filters, mode.mimeTypes);
  }
  return filters;
};

const filtersForMode = (
  mode: SearchDialogMode,
  filters: SearchFilters,
): SearchFilters =>
  mode.type === "pick"
    ? enforceDocumentPickFilters(filters, mode.mimeTypes)
    : filters;

type SearchFiltersUpdate =
  | SearchFilters
  | ((filters: SearchFilters) => SearchFilters);

type SearchResultsStatus =
  | { type: "hidden" }
  | { type: "unavailable" }
  | { type: "error" }
  | { type: "loading" }
  | { query: string | null; type: "empty" }
  | { type: "results" };

const resolveSearchResultsStatus = ({
  hasActiveSearch,
  hasQuery,
  hasResults,
  hasUnavailableSelectedType,
  hasVisibleSearch,
  isBlockingSearchError,
  isLoading,
  searchQuery,
}: {
  hasActiveSearch: boolean;
  hasQuery: boolean;
  hasResults: boolean;
  hasUnavailableSelectedType: boolean;
  hasVisibleSearch: boolean;
  isBlockingSearchError: boolean;
  isLoading: boolean;
  searchQuery: string;
}): SearchResultsStatus => {
  if (!hasVisibleSearch) {
    return { type: "hidden" };
  }
  if (hasUnavailableSelectedType) {
    return { type: "unavailable" };
  }
  if (hasActiveSearch && isBlockingSearchError) {
    return { type: "error" };
  }
  if (
    !isBlockingSearchError &&
    !hasResults &&
    (!hasActiveSearch || isLoading)
  ) {
    return { type: "loading" };
  }
  if (hasActiveSearch && !isBlockingSearchError && !isLoading && !hasResults) {
    return { query: hasQuery ? searchQuery : null, type: "empty" };
  }
  return !isBlockingSearchError && hasResults
    ? { type: "results" }
    : { type: "hidden" };
};

type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialWorkspaceId?: string | undefined;
  mode?: SearchDialogMode;
};

export const SearchDialog = ({
  open,
  onOpenChange,
  initialWorkspaceId,
  mode = BROWSE_MODE,
}: SearchDialogProps) => {
  const t = useTranslations();
  const locale = useLocale();
  // The AI search API caps locale at 16 chars; send the base language, not the
  // formatting locale (which may carry a region and -u- extensions).
  const apiLocale = useI18nStore((s) => s.loadedLang);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthenticatedUser();
  const isMobile = useIsMobile();
  const publicLawPreviewEnabled = usePublicLawPreviewEnabled();
  const [closeActionQueue] = useState(createDialogCloseActionQueue);
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
  // Draggable column widths. `null` keeps the default responsive classes;
  // a drag pins the column to a px width via the CSS variables below
  // (session-only, like the inspector pane resize).
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const [facetsWidth, setFacetsWidth] = useState<number | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  // Cmd/Ctrl held while activating a result switches "open the hit" to
  // "open its matter location". Tracked at the window (state, not a ref, so
  // the preview's Open button can relabel itself while the modifier is
  // down) and additionally read off the activating click itself, which
  // covers a modifier already held before the dialog opened.
  const [locationModifierHeld, setLocationModifierHeld] = useState(false);
  useExternalSyncEffect(() => {
    if (!open) {
      setLocationModifierHeld(false);
      return undefined;
    }
    const syncModifier = (event: KeyboardEvent) => {
      setLocationModifierHeld(event.metaKey || event.ctrlKey);
    };
    const resetModifier = () => {
      setLocationModifierHeld(false);
    };
    window.addEventListener("keydown", syncModifier, true);
    window.addEventListener("keyup", syncModifier, true);
    window.addEventListener("blur", resetModifier);
    return () => {
      window.removeEventListener("keydown", syncModifier, true);
      window.removeEventListener("keyup", syncModifier, true);
      window.removeEventListener("blur", resetModifier);
    };
  }, [open]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [highlightedHitId, setHighlightedHitId] = useState<string | null>(null);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recentPreviewFile, setRecentPreviewFile] = useState<RecentFile | null>(
    null,
  );
  const [filters, setFilterState] = useState<SearchFilters>(() =>
    initialFiltersForMode(mode, initialWorkspaceId),
  );
  const setFilters = (update: SearchFiltersUpdate) => {
    setFilterState((current) =>
      filtersForMode(
        mode,
        typeof update === "function" ? update(current) : update,
      ),
    );
  };
  const searchInputRef = useRef<HTMLInputElement>(null);

  const debouncedSetQuery = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
  }, DEBOUNCE_MS);
  const debouncedSetHighlightedHitId = useDebouncedCallback(
    setHighlightedHitId,
    PREVIEW_HIGHLIGHT_DEBOUNCE_MS,
  );

  const searchQuery = debouncedQuery.trim();
  // Resolve preset → ISO once per logical search. Memoising on
  // [filters.time, searchQuery] gives us a fresh `now() - duration`
  // whenever the user picks a new preset or runs a new query, while
  // staying stable across pagination so `fetchNextPage` keeps using
  // the same cutoff as page 1.
  const { updatedFrom } = useMemo(
    () => ({
      searchQuery,
      updatedFrom: resolveUpdatedFrom(filters.time),
    }),
    [filters.time, searchQuery],
  );
  const updatedTo = resolveUpdatedTo(filters.time);
  const availableSearchTypes = GLOBAL_SEARCH_RESULT_TYPES.filter((type) =>
    isAvailableSearchKind(type, publicLawPreviewEnabled),
  );
  const selectedSearchTypes = filters.types.filter(isSearchKindOption);
  const hasUnavailableSelectedType = hasUnavailableSearchType({
    availableTypes: availableSearchTypes,
    kinds: filters.kinds,
    selectedTypes: selectedSearchTypes,
  });
  const activeSearchTypes = resolveActiveSearchTypes({
    availableTypes: availableSearchTypes,
    kinds: filters.kinds,
    selectedTypes: selectedSearchTypes,
  });
  const hasQuery = searchQuery.trim().length > 0;
  const hasSearchCriteria = hasSearchQueryOrSelectiveFilter({
    query: searchQuery,
    types: filters.types,
    kinds: filters.kinds,
    editedByUserIds: filters.editedByUserIds,
    mimeTypes: filters.mimeTypes,
    updatedFrom,
    updatedTo,
  });
  const hasExplicitSearchFilters = hasSearchQueryOrSelectiveFilter({
    query: "",
    types: filters.types,
    kinds: filters.kinds,
    editedByUserIds: filters.editedByUserIds,
    mimeTypes: filters.mimeTypes,
    updatedFrom,
    updatedTo,
  });
  const hasActiveSearch = hasSearchCriteria && !hasUnavailableSelectedType;
  const hasTypedQuery = query.trim().length > 0;
  const hasVisibleSearch = hasTypedQuery || hasExplicitSearchFilters;

  const {
    data,
    error: searchError,
    isError: isSearchError,
    isLoading,
    isFetching,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isPlaceholderData,
    refetch: refetchSearch,
  } = useInfiniteQuery(
    searchInfiniteOptions({
      enabled: hasActiveSearch,
      organizationId: searchRecentsScope.organizationId,
      userId: searchRecentsScope.userId,
      query: searchQuery,
      workspaceIds: filters.workspaceIds,
      kinds: filters.kinds,
      types: activeSearchTypes,
      editedByUserIds: filters.editedByUserIds,
      mimeTypes: filters.mimeTypes,
      updatedFrom,
      updatedTo,
    }),
  );
  const isBlockingSearchError = isSearchError && !isFetchNextPageError;

  // Keyed by value: the caller rebuilds the mode object every render, and the
  // exclusion only needs to invalidate when the excluded set itself changes.
  const excludedEntityIds =
    mode.type === "pick" ? mode.excludeEntityIds : NO_EXCLUDED_ENTITY_IDS;
  const excludedEntityIdsKey = excludedEntityIds.join("|");
  const allHits = useMemo(() => {
    if (!data) {
      return EMPTY_SEARCH_HITS;
    }
    const hits = data.pages.flatMap((page) => page.hits);
    if (excludedEntityIdsKey.length === 0) {
      return hits;
    }
    const excluded = new Set(excludedEntityIdsKey.split("|"));
    return hits.filter(
      (hit) => !("entityId" in hit) || !excluded.has(hit.entityId),
    );
  }, [data, excludedEntityIdsKey]);
  const previewLocatorCandidates =
    data?.pages.at(0)?.previewLocatorCandidates ??
    EMPTY_SEARCH_PREVIEW_LOCATOR_CANDIDATES;
  const getHitVirtualKey = (index: number) => allHits.at(index)?.id ?? index;
  const previewHit = selectSearchPreviewHit({
    highlightedHitId,
    hits: allHits,
    isPlaceholderData,
  });
  const showPreview = shouldShowSearchPreview({ isMobile, previewEnabled });
  const displayedPreviewHit = selectDisplayedSearchPreviewHit({
    hit: previewHit,
    showPreview,
  });
  const displayedRecentFile =
    showPreview && !hasVisibleSearch ? recentPreviewFile : null;

  // Counts and facets are computed only on the first page (see backend);
  // ignore them entirely while the query is empty so a cleared input
  // doesn't leave stale numbers in the sidebar.
  const firstPage =
    hasActiveSearch && !isBlockingSearchError ? data?.pages.at(0) : undefined;
  const facets = firstPage?.facets;
  const typeBuckets = facets ? facets.type : EMPTY_FACET_BUCKETS;
  const mimeTypeBuckets = facets ? facets.mimeType : EMPTY_FACET_BUCKETS;
  const editorBuckets = facets ? facets.editor : EMPTY_FACET_BUCKETS;
  const workspaceBuckets = facets ? facets.workspace : EMPTY_FACET_BUCKETS;
  const totalCount = firstPage?.totalCount ?? 0;
  const filterTypesKey = filters.types.join("|");
  const filterKindsKey = filters.kinds.join("|");
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

  // Refresh the recents snapshot from localStorage on the open transition (and
  // if the scope changes while open). The recents are also locally mutated by
  // the result/search handlers below, so this is guarded against the last-seen
  // key rather than read unconditionally: an unguarded render-time read would
  // re-run on every render and clobber those in-session mutations. SearchDialog
  // itself never unmounts (both call sites render it unconditionally and
  // control visibility via `open`), so there is no mount to hang this off of.
  const recentsSnapshotKey = open
    ? `${searchRecentsScope.organizationId}:${searchRecentsScope.userId}`
    : null;
  const [lastRecentsSnapshotKey, setLastRecentsSnapshotKey] = useState<
    string | null
  >(null);
  if (recentsSnapshotKey !== lastRecentsSnapshotKey) {
    setLastRecentsSnapshotKey(recentsSnapshotKey);
    setRecentPreviewFile(null);
    if (recentsSnapshotKey) {
      setRecentSearches(readRecentSearches(searchRecentsScope));
      setRecentFiles(readRecentFiles(searchRecentsScope));
    }
  }

  const searchFilterParams = {
    workspaceIds: filters.workspaceIds,
    types: activeSearchTypes,
    editedByUserIds: filters.editedByUserIds,
    mimeTypes: filters.mimeTypes,
    updatedFrom,
    updatedTo,
  };

  const facetSearchParams = {
    enabled: hasActiveSearch,
    organizationId: searchRecentsScope.organizationId,
    userId: searchRecentsScope.userId,
    query: searchQuery,
    kinds: filters.kinds,
    ...searchFilterParams,
  };

  const analytics = useAnalytics();
  useExternalSyncEffect(() => {
    if (searchError) {
      analytics.captureError(searchError);
    }
  }, [analytics, searchError]);

  // summarizeSearchEndpoint (POST /search/summary) and the follow-up
  // "Ask about these results" chat (POST /search/summary/chat) both
  // require chat:create; hide the AI summary control for roles that
  // lack it instead of surfacing a 403 on click.
  const canSummarizeSearch = usePermissions({ chat: ["create"] });
  const showSearchSummary = canShowSearchSummary({
    canSummarizeSearch,
    query: searchQuery,
  });

  // Tab-to-ask-AI hands the query off to a fresh chat thread, so it needs
  // the same chat:create permission as the summary chat, plus a usable AI
  // config (in production AI is BYOK-gated per organization). Availability
  // is only fetched while the dialog is open to keep route loads untouched.
  const userContext = useChatUserContext();
  const getUserContext = useLatestCallback(() => userContext);
  const { data: aiAvailability } = useQuery({
    ...aiAvailabilityOptions({
      organizationId: searchRecentsScope.organizationId,
    }),
    enabled: open,
  });
  const canAskAI = canSummarizeSearch && aiAvailability?.available === true;

  const { resolvedActions, executeAction } = useCommandActions();

  const normalizedActionQuery = query.trim().toLowerCase();
  const filteredActions = resolvedActions.filter(
    (action) =>
      normalizedActionQuery.length === 0 ||
      action.title.toLowerCase().includes(normalizedActionQuery) ||
      action.keywordLabels.some((keyword) =>
        keyword.toLowerCase().includes(normalizedActionQuery),
      ),
  );

  const handleActionSelect = (actionId: string) => {
    executeAction(actionId);
    onOpenChange(false);
  };

  const summarizeSearchMutation = useMutation({
    mutationFn: async (params: SearchAISummaryParams) => {
      const response = await api.search.summary.post({
        query: params.query,
        locale: params.locale,
        ...(params.originalQuery !== undefined && {
          originalQuery: params.originalQuery,
        }),
        workspaceIds: params.workspaceIds.map((id) =>
          toSafeId<"workspace">(id),
        ),
        types: params.types,
        editedByUserIds: params.editedByUserIds,
        mimeTypes: params.mimeTypes,
        ...(params.updatedFrom ? { updatedFrom: params.updatedFrom } : {}),
        ...(params.updatedTo ? { updatedTo: params.updatedTo } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });

      return unwrapEden(response);
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

      return unwrapEden(response);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const createSummaryChatMutation = useMutation({
    mutationFn: async (vars: CreateSearchSummaryChatVars) => {
      const response = await api.search.summary.chat.post({
        query: vars.query,
        title: vars.title,
        summary: vars.summary,
        citations: vars.citations.map((citation) => ({
          number: citation.number,
        })),
        ...(vars.originalQuery !== undefined && {
          originalQuery: vars.originalQuery,
        }),
        workspaceIds: vars.workspaceIds.map((id) => toSafeId<"workspace">(id)),
        types: vars.types,
        editedByUserIds: vars.editedByUserIds,
        mimeTypes: vars.mimeTypes,
        ...(vars.updatedFrom ? { updatedFrom: vars.updatedFrom } : {}),
        ...(vars.updatedTo ? { updatedTo: vars.updatedTo } : {}),
        ...(vars.limit !== undefined ? { limit: vars.limit } : {}),
      });

      return unwrapEden(response);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  // Mirrors the `/new <message>` handoff from the chat landing: start the
  // stream on a fresh global thread before navigating so the thread page
  // mounts onto the already-busy runtime.
  const askAIMutation = useMutation({
    mutationFn: async (queryText: string) => {
      const threadRef: ChatThreadRef = {
        scope: "global",
        threadId: createChatThreadId(),
      };
      await startNewThreadCommandHandoff({
        activeOrganizationId: searchRecentsScope.organizationId,
        context: {
          allowMissingThread: true,
          getUserContext,
          getContextMatterIds: () => [],
          getSendMode: () => getChatSendMode(threadRef),
        },
        files: [],
        html: toAskAIMessageHtml(queryText),
        queryClient,
        threadRef,
      });
      return threadRef.threadId;
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
  });

  const clearSearchQuery = () => {
    debouncedSetQuery.cancel();
    setQuery("");
    setDebouncedQuery("");
    setRecentPreviewFile(null);
    summarizeSearchMutation.reset();
  };

  const clearSearch = () => {
    clearSearchQuery();
    setFilters(initialFiltersForMode(mode, initialWorkspaceId));
  };

  const handleSummarizeResults = () => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery || summarizeSearchMutation.isPending) {
      return;
    }

    summarizeSearchMutation.mutate({
      query: trimmedQuery,
      locale: apiLocale,
      ...searchFilterParams,
      limit: 5,
    });
  };

  const navigateAfterClose = (navigateToTarget: () => Promise<unknown>) => {
    closeActionQueue.schedule(() => {
      detached(
        navigateToTarget().catch((error: unknown) => {
          analytics.captureError(error);
          stellaToast.add({
            title: t("common.somethingWentWrong"),
            type: "error",
          });
        }),
        "search-dialog.navigate-to-target",
      );
    });
    onOpenChange(false);
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
        locale: apiLocale,
        title: summaryData.title,
        summary: summaryData.summary,
        citations: summaryData.citations,
        ...searchFilterParams,
        limit: 5,
      },
      {
        onSuccess: (thread) => {
          navigateAfterClose(async () => {
            await navigate({
              to: "/chat/$threadId",
              params: { threadId: thread.threadId },
            });
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
      { query: trimmedQuery, locale: apiLocale },
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

  const handleAskAI = () => {
    const trimmedQuery = query.trim();
    if (!canAskAI || !trimmedQuery || askAIMutation.isPending) {
      return;
    }
    setRecentSearches(recordRecentSearch(trimmedQuery, searchRecentsScope));
    askAIMutation.mutate(trimmedQuery, {
      onSuccess: (threadId) => {
        detached(
          invalidateGroupedChatThreads(queryClient),
          "search-dialog.invalidate-grouped-chat-threads",
        );
        navigateAfterClose(async () => {
          await navigate({ to: "/chat/$threadId", params: { threadId } });
        });
      },
    });
  };

  const applyRecentSearch = (recent: RecentSearch) => {
    setRecentPreviewFile(null);
    setQuery(recent.query);
    setDebouncedQuery(recent.query);
    summarizeSearchMutation.reset();
    setRecentSearches(recordRecentSearch(recent.query, searchRecentsScope));
  };

  // Formats without a mime-only full-screen viewer (emails, markdown,
  // anything unknown) open inside their matter: navigate to the workspace,
  // then hand the entity to the inspector, which resolves the right file
  // facet (email HTML viewer, markdown, metadata plus download as the
  // floor).
  const openFileInWorkspaceInspector = async ({
    entityId,
    label,
    workspaceId,
  }: {
    entityId: string;
    label: string;
    workspaceId: string;
  }) => {
    await navigate(getEntityWorkspaceRoute({ workspaceId }));
    await openEntityInInspector(entityId, label, workspaceId);
  };

  const openRecentFile = (file: RecentFile) => {
    // Recent entries do not persist a containing folder, so the modifier
    // opens the matter root.
    if (locationModifierHeld) {
      navigateAfterClose(async () => {
        await navigate(
          getEntityWorkspaceRoute({ workspaceId: file.workspaceId }),
        );
      });
      return;
    }
    navigateAfterClose(async () => {
      if (
        resolveFileOpenTarget(file.mimeType ?? null) ===
        FILE_OPEN_TARGET.workspaceInspector
      ) {
        setRecentFiles(recordRecentFile(file, searchRecentsScope));
        await openFileInWorkspaceInspector({
          entityId: file.entityId,
          label: file.title,
          workspaceId: file.workspaceId,
        });
        return;
      }
      const fileFieldId = await queryClient.query(
        recentFilePreviewFieldOptions({
          entityId: file.entityId,
          fileFieldId: file.fileFieldId,
          filePropertyId: file.filePropertyId,
          mimeType: file.mimeType ?? null,
          organizationId: searchRecentsScope.organizationId,
          userId: searchRecentsScope.userId,
          workspaceId: file.workspaceId,
        }),
      );
      const resolvedFile = { ...file, fileFieldId };
      setRecentFiles(recordRecentFile(resolvedFile, searchRecentsScope));
      await navigate(getRecentFileRoute(resolvedFile));
    });
  };

  const handleResultClick = (
    hit: GlobalSearchHit,
    options?: { locationModifier?: boolean },
  ) => {
    if (query.trim()) {
      setRecentSearches(recordRecentSearch(query, searchRecentsScope));
    }

    if (mode.type === "pick") {
      // Pick mode never navigates: only an accepted document hit does
      // anything, and it goes back to the caller with a pinnable file field.
      if (hit.type !== "document") {
        return;
      }
      const { mimeType } = hit;
      if (mimeType === null || !mode.mimeTypes.includes(mimeType)) {
        return;
      }
      navigateAfterClose(async () => {
        const { fileFieldId } = await resolveEntityDocumentRoute({
          hit,
          resolveCurrentFileFieldId: async () =>
            await queryClient.query(
              recentFilePreviewFieldOptions({
                entityId: hit.entityId,
                fileFieldId: hit.fileFieldId,
                filePropertyId: hit.filePropertyId,
                mimeType,
                organizationId: searchRecentsScope.organizationId,
                userId: searchRecentsScope.userId,
                workspaceId: hit.workspaceId,
              }),
            ),
        });
        // A hit whose current file cannot be resolved has nothing to pin.
        if (fileFieldId === null) {
          return;
        }
        mode.onPick({
          workspaceId: hit.workspaceId,
          workspaceName: hit.workspaceName,
          entityId: hit.entityId,
          fileFieldId,
          name: hit.title || hit.id,
        });
      });
      return;
    }

    if (locationModifierHeld || options?.locationModifier === true) {
      const locationRoute = getEntityLocationRoute(hit);
      if (locationRoute) {
        navigateAfterClose(async () => {
          await navigate(locationRoute);
        });
        return;
      }
    }

    if (hit.type === "contact") {
      navigateAfterClose(async () => {
        await navigate({
          to: "/contacts/$contactId",
          params: { contactId: hit.contactId },
        });
      });
      return;
    }

    if (hit.type === "case-law") {
      if (!isPublicLawPreviewEnabled()) {
        onOpenChange(false);
        stellaToast.add({
          title: t("common.comingSoon"),
          type: "neutral",
        });
        return;
      }

      const slug =
        "slug" in hit && typeof hit.slug === "string" ? hit.slug : null;
      navigateAfterClose(async () => {
        await navigate({
          to: "/law/$country/cases/$court/$slug",
          params: createCaseLawDecisionRouteParams({
            caseNumber: hit.caseNumber,
            country: hit.country,
            court: hit.court,
            decisionId: hit.decisionId,
            slug,
          }),
          search: {
            ...(hit.headline && {
              q: getFirstSearchHighlightText(hit.headline, ""),
            }),
          },
        });
      });
      return;
    }

    if (hit.type === "matter") {
      navigateAfterClose(async () => {
        await navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: hit.workspaceId },
        });
      });
      return;
    }

    if (hit.type === "chat") {
      navigateAfterClose(async () => {
        await navigate(getChatHitRoute(hit));
      });
      return;
    }

    if (hit.type === "document") {
      if (
        resolveFileOpenTarget(hit.mimeType) ===
        FILE_OPEN_TARGET.workspaceInspector
      ) {
        navigateAfterClose(async () => {
          setRecentFiles(
            recordRecentFile(
              {
                entityId: hit.entityId,
                fileFieldId: hit.fileFieldId,
                filePropertyId: hit.filePropertyId,
                mimeType: hit.mimeType,
                title: hit.title || hit.id,
                workspaceId: hit.workspaceId,
                workspaceName: hit.workspaceName,
                updatedAt: hit.updatedAt,
              },
              searchRecentsScope,
            ),
          );
          await openFileInWorkspaceInspector({
            entityId: hit.entityId,
            label: hit.title || hit.id,
            workspaceId: hit.workspaceId,
          });
        });
        return;
      }
      navigateAfterClose(async () => {
        const { fileFieldId, route } = await resolveEntityDocumentRoute({
          hit,
          resolveCurrentFileFieldId: async () =>
            await queryClient.query(
              recentFilePreviewFieldOptions({
                entityId: hit.entityId,
                fileFieldId: hit.fileFieldId,
                filePropertyId: hit.filePropertyId,
                mimeType: hit.mimeType,
                organizationId: searchRecentsScope.organizationId,
                userId: searchRecentsScope.userId,
                workspaceId: hit.workspaceId,
              }),
            ),
        });
        setRecentFiles(
          recordRecentFile(
            {
              entityId: hit.entityId,
              fileFieldId,
              filePropertyId: hit.filePropertyId,
              mimeType: hit.mimeType,
              title: hit.title || hit.id,
              workspaceId: hit.workspaceId,
              workspaceName: hit.workspaceName,
              updatedAt: hit.updatedAt,
            },
            searchRecentsScope,
          ),
        );
        await navigate(route);
      });
      return;
    }

    navigateAfterClose(async () => {
      await navigate(getEntityWorkspaceRoute(hit));
    });
  };

  const openSearchResult = (
    hit: GlobalSearchHit,
    options?: { locationModifier?: boolean },
  ): void => {
    handleResultClick(hit, options);
  };

  const hasResults = allHits.length > 0;
  const shouldShowResults =
    hasVisibleSearch &&
    !hasUnavailableSelectedType &&
    !isBlockingSearchError &&
    hasResults;
  const commandHits = shouldShowResults ? allHits : [];
  const resultsStatus = resolveSearchResultsStatus({
    hasActiveSearch,
    hasQuery,
    hasResults,
    hasUnavailableSelectedType,
    hasVisibleSearch,
    isBlockingSearchError,
    isLoading,
    searchQuery,
  });
  const filterEditorIdsKey = filters.editedByUserIds.join("|");

  // Clear any prior AI summary whenever the effective search changes. The
  // debounced `searchQuery` updates asynchronously (no handler to co-locate
  // with) and the filter setters fan out across ~7 handlers, so there is no
  // single trigger site to relay the reset into.
  // The mutation observer is an external system, not render state, so
  // resetting it belongs in a committed effect keyed on those values
  // rather than during render (which can re-run for renders React discards
  // and would double-fire under strict mode). `reset` is a stable
  // function reference from the mutation observer, so listing it alongside
  // `resetKey` still only fires this once per real search change.
  const resetSummarizeSearch = summarizeSearchMutation.reset;
  useExternalSyncEffect(() => {
    resetSummarizeSearch();
  }, [
    filterEditorIdsKey,
    filterKindsKey,
    filterMimeTypesKey,
    filterTypesKey,
    filterWorkspaceIdsKey,
    filters.time,
    resetSummarizeSearch,
    searchQuery,
  ]);

  const loadMoreRef = useCallback(
    (target: HTMLDivElement | null) => {
      const root = resultsElement;
      if (!hasActiveSearch || !hasNextPage || !root || !target) {
        return undefined;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.at(0);
          if (!entry?.isIntersecting || isFetchingNextPage) {
            return;
          }
          detached(fetchNextPage(), "search-dialog.fetch-next-page");
        },
        { root, rootMargin: "160px 0px" },
      );

      observer.observe(target);
      return () => observer.disconnect();
    },
    [
      fetchNextPage,
      hasActiveSearch,
      hasNextPage,
      isFetchingNextPage,
      resultsElement,
    ],
  );

  // Roving focus for the zero-query screen: the saved-search and recents
  // rows are ordinary buttons, not command items, so the listbox highlight
  // never reaches them. ArrowDown from the input walks them in DOM order
  // (saved searches, then recent searches, then recent files); ArrowUp from
  // the first row returns to the input.
  const getEmptyScreenRows = (): HTMLElement[] =>
    resultsElement === null
      ? []
      : [
          ...resultsElement.querySelectorAll<HTMLElement>(
            "[data-search-empty-row]",
          ),
        ];

  const handleEmptyScreenListKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (hasVisibleSearch) {
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const rows = getEmptyScreenRows();
    const { target } = event;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const index = rows.findIndex(
      (row) => row === target || row.contains(target),
    );
    if (index === -1) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowDown") {
      rows.at(index + 1)?.focus();
      return;
    }
    if (index === 0) {
      searchInputRef.current?.focus();
      return;
    }
    rows.at(index - 1)?.focus();
  };

  // Divider drags report the pointer's clientX; widths are measured from the
  // start edge of the columns row, so the math flips under RTL.
  const resizeFacetsColumn = (clientX: number) => {
    const container = contentAreaRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const isRtl = getComputedStyle(container).direction === "rtl";
    const next = isRtl ? rect.right - clientX : clientX - rect.left;
    // The results column absorbs what the facets take, so its current slack
    // over the floor bounds the growth — whatever width the preview column
    // holds right now (dragged or CSS default), the results never drop
    // below their minimum whichever divider moves second.
    const resultsWidth = resultsElement?.getBoundingClientRect().width;
    const maxBesideResults =
      resultsWidth === undefined
        ? SEARCH_FACETS_MAX_WIDTH
        : (facetsWidth ?? SEARCH_FACETS_DEFAULT_WIDTH) +
          resultsWidth -
          SEARCH_RESULTS_MIN_WIDTH;
    setFacetsWidth(
      Math.max(
        SEARCH_FACETS_MIN_WIDTH,
        Math.min(SEARCH_FACETS_MAX_WIDTH, maxBesideResults, next),
      ),
    );
  };

  const resizePreviewColumn = (clientX: number) => {
    const container = contentAreaRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const isRtl = getComputedStyle(container).direction === "rtl";
    const next = isRtl ? clientX - rect.left : rect.right - clientX;
    const maxBesideResults =
      rect.width -
      (facetsWidth ?? SEARCH_FACETS_DEFAULT_WIDTH) -
      SEARCH_RESULTS_MIN_WIDTH;
    setPreviewWidth(
      Math.max(
        SEARCH_PREVIEW_MIN_WIDTH,
        Math.min(SEARCH_PREVIEW_MAX_WIDTH, maxBesideResults, next),
      ),
    );
  };

  const columnsStyle: CSSProperties & {
    "--search-facets-w"?: string;
    "--search-preview-w"?: string;
  } = {};
  if (facetsWidth !== null) {
    columnsStyle["--search-facets-w"] = `${String(facetsWidth)}px`;
  }
  if (previewWidth !== null) {
    columnsStyle["--search-preview-w"] = `${String(previewWidth)}px`;
  }

  const applySavedSearch = (criteria: SavedSearchCriteria) => {
    const savedFilters = toSearchFilters(criteria);
    debouncedSetQuery.cancel();
    setRecentPreviewFile(null);
    setQuery(criteria.query);
    setDebouncedQuery(criteria.query);
    setFilters({
      workspaceIds: savedFilters.workspaceIds,
      types: savedFilters.types,
      kinds: savedFilters.kinds,
      editedByUserIds: savedFilters.editedByUserIds,
      mimeTypes: savedFilters.mimeTypes,
      ...(savedFilters.time !== undefined && { time: savedFilters.time }),
    });
    summarizeSearchMutation.reset();
    searchInputRef.current?.focus();
  };

  return (
    <CommandDialog
      onOpenChangeComplete={(nextOpen) => {
        closeActionQueue.complete(nextOpen);
      }}
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) {
          closeActionQueue.cancel();
        }
        if (
          !nextOpen &&
          eventDetails.reason === "escape-key" &&
          hasVisibleSearch
        ) {
          eventDetails.cancel();
          clearSearch();
          return;
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <CommandDialogPopup
        className={cn(
          "flex h-[calc(100dvh-32px)] w-[calc(100vw-16px)] max-w-none flex-col overflow-clip sm:h-[min(720px,calc(100dvh-96px))]",
          showPreview
            ? "sm:w-[min(1120px,calc(100vw-32px))] xl:w-[min(1280px,calc(100vw-48px))]"
            : "sm:w-[min(960px,calc(100vw-32px))]",
        )}
        layer="search"
        showCloseButton={false}
      >
        <RenderStormRegion name="search-dialog">
          <Command
            itemToStringValue={(hit) => hit.title}
            items={commandHits}
            keepHighlight
            mode="none"
            onItemHighlighted={(_, eventDetails) => {
              if (eventDetails.index < 0) {
                debouncedSetHighlightedHitId.cancel();
                return;
              }
              const highlightedHit = allHits.at(eventDetails.index);
              if (highlightedHit) {
                if (eventDetails.reason === "keyboard") {
                  debouncedSetHighlightedHitId.cancel();
                  setHighlightedHitId(highlightedHit.id);
                } else {
                  debouncedSetHighlightedHitId(highlightedHit.id);
                }
              }
              if (eventDetails.reason === "keyboard") {
                hitVirtualizer.scrollToIndex(eventDetails.index, {
                  align: "auto",
                });
              }
            }}
            onValueChange={(value, eventDetails) => {
              if (eventDetails.reason === "item-press") {
                return;
              }
              setQuery(value);
              setRecentPreviewFile(null);
              debouncedSetQuery(value);
              summarizeSearchMutation.reset();
            }}
            value={query}
            virtualized
          >
            {mode.type === "pick" && (
              <p className="bg-muted/50 text-muted-foreground shrink-0 border-b px-4 py-2 text-xs italic">
                {PICK_MODE_LABEL}
              </p>
            )}
            {/* Search input */}
            <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
              <CommandInput
                autoFocus
                className="text-sm"
                dir={contentDir(query)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && !hasVisibleSearch) {
                    const firstRow = getEmptyScreenRows().at(0);
                    if (firstRow) {
                      event.preventDefault();
                      firstRow.focus();
                    }
                    return;
                  }
                  if (event.key !== "Tab" || event.shiftKey) {
                    return;
                  }
                  if (
                    !canUseAskAIShortcut({
                      canAskAI,
                      mode: mode.type,
                      query,
                    })
                  ) {
                    return;
                  }
                  event.preventDefault();
                  handleAskAI();
                }}
                placeholder={t("search.placeholder")}
                ref={searchInputRef}
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
              <SavedSearches
                filters={filters}
                isOpen={open}
                onApply={applySavedSearch}
                overlayLayer="search-child"
                query={query}
                showList={false}
              />
              {hasVisibleSearch && (
                <Button
                  className="min-h-11 shrink-0 sm:hidden"
                  onClick={clearSearch}
                  size="sm"
                  variant="ghost"
                >
                  {t("common.reset")}
                </Button>
              )}
            </div>

            {/* Content area */}
            <div
              className="flex min-h-0 flex-1 overflow-hidden"
              ref={contentAreaRef}
              style={columnsStyle}
            >
              {/* Facets sidebar — always present so the layout stays stable. */}
              <div
                className={cn(
                  "hidden w-[var(--search-facets-w,14rem)] shrink-0 overflow-y-auto border-e px-3 py-3",
                  showPreview ? "xl:block" : "sm:block",
                )}
              >
                <SearchFacetsBody
                  editorBuckets={editorBuckets}
                  facetSearchParams={facetSearchParams}
                  filters={filters}
                  hasSearchCriteria={hasSearchCriteria}
                  locale={locale}
                  mimeTypeBuckets={mimeTypeBuckets}
                  publicLawPreviewEnabled={publicLawPreviewEnabled}
                  setFilters={setFilters}
                  typeBuckets={typeBuckets}
                  workspaceBuckets={workspaceBuckets}
                />
              </div>

              <SearchColumnResizeHandle
                className={cn("hidden", showPreview ? "xl:block" : "sm:block")}
                label={t("search.resizeFilters")}
                max={SEARCH_FACETS_MAX_WIDTH}
                min={SEARCH_FACETS_MIN_WIDTH}
                onResize={resizeFacetsColumn}
                value={facetsWidth ?? SEARCH_FACETS_DEFAULT_WIDTH}
              />

              {/* Results */}
              <CommandList
                className="max-h-none min-w-0 flex-1 overflow-y-auto"
                onKeyDown={handleEmptyScreenListKeyDown}
                ref={setResultsElement}
              >
                <SearchRecentsScreen
                  filters={filters}
                  onApplySavedSearch={applySavedSearch}
                  onFileClick={openRecentFile}
                  onFilePreview={setRecentPreviewFile}
                  onSearchClick={applyRecentSearch}
                  open={open}
                  previewedFileId={displayedRecentFile?.entityId ?? null}
                  query={query}
                  recentFiles={recentFiles}
                  recentSearches={recentSearches}
                  visible={!hasVisibleSearch}
                />
                {mode.type === "browse" && filteredActions.length > 0 && (
                  <section className="px-4 py-4">
                    <h3 className="text-muted-foreground mb-2 text-xs font-medium">
                      {t("common.actions")}
                    </h3>
                    <div className="space-y-1">
                      {filteredActions.map((action) => (
                        <CommandActionItem
                          action={action}
                          key={action.id}
                          onSelect={handleActionSelect}
                        />
                      ))}
                    </div>
                  </section>
                )}
                <SearchResultsContent
                  onRetry={() => {
                    detached(refetchSearch(), "search-dialog.refetch-search");
                  }}
                  status={resultsStatus}
                >
                  <SearchHitResults
                    hits={allHits}
                    onOpenResult={openSearchResult}
                    pagination={{
                      fetchNextPage,
                      hasNextPage,
                      isFetchNextPageError,
                      isFetchingNextPage,
                      loadMoreRef,
                    }}
                    summary={{
                      isOpeningChat: createSummaryChatMutation.isPending,
                      onOpenChat: handleOpenSummaryChat,
                      onSummarize: handleSummarizeResults,
                      summarizeMutation: summarizeSearchMutation,
                      visible: showSearchSummary,
                    }}
                    totalCount={totalCount}
                    virtual={{
                      items: virtualHits,
                      measureElement: hitVirtualizer.measureElement,
                      totalSize: hitVirtualizer.getTotalSize(),
                    }}
                  />
                </SearchResultsContent>
              </CommandList>
              <SearchPreviewColumn
                displayedHit={displayedPreviewHit}
                displayedRecentFile={displayedRecentFile}
                locationModifierHeld={locationModifierHeld}
                onOpenRecentFile={openRecentFile}
                onOpenSearchResult={openSearchResult}
                onResize={resizePreviewColumn}
                previewLocatorCandidates={previewLocatorCandidates}
                previewWidth={previewWidth}
                query={searchQuery}
                scope={searchRecentsScope}
                visible={showPreview}
              />
            </div>

            {/* Footer: keyboard hints on the left, dialog-level controls on
                the right — everything that is not the query itself lives
                here so the input row stays a plain input. */}
            <SearchDialogFooter
              canAskAI={canAskAI}
              isAskingAI={askAIMutation.isPending}
              mode={mode.type}
              onAskAI={handleAskAI}
              previewEnabled={previewEnabled}
              setPreviewEnabled={setPreviewEnabled}
            />
          </Command>
        </RenderStormRegion>
      </CommandDialogPopup>
    </CommandDialog>
  );
};

type SearchFacetsBodyProps = {
  editorBuckets: ComponentProps<typeof SearchableFacetGroup>["defaultBuckets"];
  facetSearchParams: ComponentProps<
    typeof SearchableFacetGroup
  >["searchParams"];
  filters: SearchFilters;
  hasSearchCriteria: boolean;
  locale: string;
  mimeTypeBuckets: ComponentProps<
    typeof SearchableFacetGroup
  >["defaultBuckets"];
  publicLawPreviewEnabled: boolean;
  setFilters: (update: SearchFiltersUpdate) => void;
  typeBuckets: readonly ComponentProps<typeof FacetGroup>["buckets"][number][];
  workspaceBuckets: ComponentProps<
    typeof SearchableFacetGroup
  >["defaultBuckets"];
};

const SearchFacetsBody = ({
  editorBuckets,
  facetSearchParams,
  filters,
  hasSearchCriteria,
  locale,
  mimeTypeBuckets,
  publicLawPreviewEnabled,
  setFilters,
  typeBuckets,
  workspaceBuckets,
}: SearchFacetsBodyProps) => {
  const t = useTranslations();
  const toggleFilter = (
    key: "editedByUserIds" | "mimeTypes" | "types" | "workspaceIds",
    value: string,
  ) => {
    setFilters((current) => ({
      ...current,
      [key]: toggleArrayMember(current[key], value),
    }));
  };
  const selectedTypeBuckets = mergeSelectedBuckets(
    typeBuckets.flatMap((bucket) => {
      if (!isSearchKindOption(bucket.value)) {
        return [];
      }
      if (!isAvailableSearchKind(bucket.value, publicLawPreviewEnabled)) {
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
      isSearchKindOption(value) ? t(KIND_TRANSLATION_KEYS[value]) : value,
  );
  return (
    <>
      <TimeFacetGroup
        locale={locale}
        onClearCustom={() => setFilters(clearTime)}
        onCustomChange={(range) =>
          setFilters((current) => setCustomTime(current, range))
        }
        onPresetChange={(preset) =>
          setFilters((current) =>
            setPresetTime(
              current,
              current.time?.mode === "preset" && current.time.preset === preset
                ? undefined
                : preset,
            ),
          )
        }
        time={filters.time}
      />
      {hasSearchCriteria && (
        <>
          {typeBuckets.length + filters.types.length > 0 && (
            <div className="mt-4">
              <FacetGroup
                buckets={selectedTypeBuckets}
                onChange={(value) => {
                  if (isSearchKindOption(value)) {
                    toggleFilter("types", value);
                  }
                }}
                selected={filters.types}
                title={t("common.kind")}
              />
            </div>
          )}
          <div className="mt-4">
            <SearchableFacetGroup
              defaultBuckets={mimeTypeBuckets}
              facet="mimeType"
              formatLabel={(bucket) => formatMimeTypeLabel(bucket.value)}
              onChange={(value) => toggleFilter("mimeTypes", value)}
              searchParams={facetSearchParams}
              selected={filters.mimeTypes}
              title={t("search.mimeType")}
            />
          </div>
          <div className="mt-4">
            <SearchableFacetGroup
              defaultBuckets={editorBuckets}
              facet="editor"
              onChange={(value) => toggleFilter("editedByUserIds", value)}
              searchParams={facetSearchParams}
              selected={filters.editedByUserIds}
              title={t("search.editedBy")}
            />
          </div>
          <div className="mt-4">
            <SearchableFacetGroup
              defaultBuckets={workspaceBuckets}
              facet="workspace"
              onChange={(value) => toggleFilter("workspaceIds", value)}
              searchParams={facetSearchParams}
              selected={filters.workspaceIds}
              title={t("common.matter")}
            />
          </div>
        </>
      )}
    </>
  );
};

type SearchPreviewColumnProps = {
  displayedHit: ComponentProps<typeof SearchPreviewPanel>["hit"] | null;
  displayedRecentFile: RecentFile | null;
  locationModifierHeld: boolean;
  onOpenRecentFile: (file: RecentFile) => void;
  onOpenSearchResult: ComponentProps<typeof SearchPreviewPanel>["onOpen"];
  onResize: (clientX: number) => void;
  previewLocatorCandidates: ComponentProps<
    typeof SearchPreviewPanel
  >["previewLocatorCandidates"];
  previewWidth: number | null;
  query: string;
  scope: SearchRecentsScope;
  visible: boolean;
};

const SearchPreviewColumn = ({
  displayedHit,
  displayedRecentFile,
  locationModifierHeld,
  onOpenRecentFile,
  onOpenSearchResult,
  onResize,
  previewLocatorCandidates,
  previewWidth,
  query,
  scope,
  visible,
}: SearchPreviewColumnProps) => {
  const t = useTranslations();
  if (!visible) {
    return null;
  }
  let content;
  if (displayedHit !== null) {
    content = (
      <SearchPreviewPanel
        hit={displayedHit}
        locationModifierHeld={locationModifierHeld}
        onOpen={onOpenSearchResult}
        organizationId={scope.organizationId}
        previewLocatorCandidates={previewLocatorCandidates}
        query={query}
        userId={scope.userId}
      />
    );
  } else if (displayedRecentFile !== null) {
    content = (
      <RecentFilePreviewPanel
        file={displayedRecentFile}
        locationModifierHeld={locationModifierHeld}
        organizationId={scope.organizationId}
        onOpen={() => onOpenRecentFile(displayedRecentFile)}
        userId={scope.userId}
      />
    );
  } else {
    content = (
      <div
        aria-hidden="true"
        className={SEARCH_PREVIEW_COLUMN_CLASS_NAME}
        data-slot="search-preview-placeholder"
      />
    );
  }
  return (
    <>
      <SearchColumnResizeHandle
        className="hidden md:block"
        label={t("search.resizePreview")}
        max={SEARCH_PREVIEW_MAX_WIDTH}
        min={SEARCH_PREVIEW_MIN_WIDTH}
        onResize={onResize}
        value={previewWidth ?? SEARCH_PREVIEW_DEFAULT_WIDTH}
      />
      {content}
    </>
  );
};

type SearchDialogFooterProps = {
  canAskAI: boolean;
  isAskingAI: boolean;
  mode: SearchDialogMode["type"];
  onAskAI: () => void;
  previewEnabled: boolean;
  setPreviewEnabled: Dispatch<SetStateAction<boolean>>;
};

const SearchDialogFooter = ({
  canAskAI,
  isAskingAI,
  mode,
  onAskAI,
  previewEnabled,
  setPreviewEnabled,
}: SearchDialogFooterProps) => {
  const t = useTranslations();
  return (
    <div className="flex shrink-0 items-center gap-4 border-t px-4 py-1.5">
      <div className="text-muted-foreground flex items-center gap-4 text-xs">
        <SearchFooterHint translationKey="search.hintNavigate" />
        {mode === "pick" ? (
          <span className="hidden items-center gap-1 sm:inline-flex">
            <kbd className="border-border bg-muted rounded border px-1 py-0.5 text-[0.625rem] leading-none">
              ↵
            </kbd>
            {PICK_HINT_LABEL}
          </span>
        ) : (
          <SearchFooterHint translationKey="search.hintOpen" />
        )}
        {canAskAI && mode === "browse" && (
          <Button
            aria-keyshortcuts="Tab"
            className="text-muted-foreground hover:text-foreground h-auto gap-1.5 px-1 py-0.5 text-xs font-normal sm:text-xs"
            disabled={isAskingAI}
            onClick={onAskAI}
            variant="ghost"
          >
            {isAskingAI && <LoaderIcon className="size-3 animate-spin" />}
            <span className="sm:hidden">{t("common.askAI")}</span>
            <span className="hidden sm:inline">
              <SearchFooterHintText translationKey="search.hintAskAI" />
            </span>
          </Button>
        )}
        <SearchFooterHint translationKey="search.hintClose" />
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-1">
        <Button
          aria-label={t("common.preview")}
          aria-pressed={previewEnabled}
          className="hidden size-8 shrink-0 md:inline-flex"
          onClick={() => setPreviewEnabled((enabled) => !enabled)}
          size="icon-sm"
          title={t("common.preview")}
          variant={previewEnabled ? "secondary" : "ghost"}
        >
          <DirectionalIcon className="size-4" icon={PanelRightIcon} />
        </Button>
      </div>
    </div>
  );
};

type SearchRecentsScreenProps = {
  filters: SearchFilters;
  onApplySavedSearch: (criteria: SavedSearchCriteria) => void;
  onFileClick: (file: RecentFile) => void;
  onFilePreview: (file: RecentFile) => void;
  onSearchClick: (search: RecentSearch) => void;
  open: boolean;
  previewedFileId: string | null;
  query: string;
  recentFiles: RecentFile[];
  recentSearches: RecentSearch[];
  visible: boolean;
};

const SearchRecentsScreen = ({
  filters,
  onApplySavedSearch,
  onFileClick,
  onFilePreview,
  onSearchClick,
  open,
  previewedFileId,
  query,
  recentFiles,
  recentSearches,
  visible,
}: SearchRecentsScreenProps) => {
  if (!visible) {
    return null;
  }
  return (
    <>
      <SavedSearches
        filters={filters}
        isOpen={open}
        onApply={onApplySavedSearch}
        overlayLayer="search-child"
        query={query}
        showTrigger={false}
      />
      <SearchRecents
        onFileClick={onFileClick}
        onFilePreview={onFilePreview}
        onSearchClick={onSearchClick}
        previewedFileId={previewedFileId}
        recentFiles={recentFiles}
        recentSearches={recentSearches}
      />
    </>
  );
};

const SearchResultsContent = ({
  children,
  onRetry,
  status,
}: {
  children: ReactElement;
  onRetry: () => void;
  status: SearchResultsStatus;
}): ReactElement | null => {
  const t = useTranslations();
  switch (status.type) {
    case "hidden":
      return null;
    case "unavailable":
      return (
        <div className="flex h-full items-center justify-center px-4 py-8">
          <p className="text-muted-foreground text-sm">
            {t("common.comingSoon")}
          </p>
        </div>
      );
    case "error":
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-8">
          <p className="text-muted-foreground text-sm">
            {t("common.somethingWentWrong")}
          </p>
          <Button onClick={onRetry} size="sm" variant="outline">
            {t("common.retry")}
          </Button>
        </div>
      );
    case "loading":
      return (
        <div className="space-y-3 px-4 py-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="space-y-2" key={`skeleton-${String(index)}`}>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      );
    case "empty":
      return (
        <div className="flex h-full items-center justify-center px-4 py-8">
          <p className="text-muted-foreground text-sm">
            {status.query === null
              ? t("common.noResults")
              : t("search.noResults", { query: status.query })}
          </p>
        </div>
      );
    case "results":
      return children;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

type SearchHitResultsProps = {
  hits: readonly GlobalSearchHit[];
  onOpenResult: ComponentProps<typeof SearchResultItem>["onClick"];
  pagination: {
    fetchNextPage: () => Promise<unknown>;
    hasNextPage: boolean;
    isFetchNextPageError: boolean;
    isFetchingNextPage: boolean;
    loadMoreRef: (target: HTMLDivElement | null) => (() => void) | undefined;
  };
  summary: {
    isOpeningChat: boolean;
    onOpenChat: () => void;
    onSummarize: () => void;
    summarizeMutation: ComponentProps<
      typeof SearchSummaryItem
    >["summarizeMutation"];
    visible: boolean;
  };
  totalCount: number;
  virtual: {
    items: VirtualItem[];
    measureElement: (element: Element | null) => void;
    totalSize: number;
  };
};

const SearchHitResults = ({
  hits,
  onOpenResult,
  pagination,
  summary,
  totalCount,
  virtual,
}: SearchHitResultsProps) => {
  const t = useTranslations();
  return (
    <div className="px-2 py-2">
      <p className="text-muted-foreground px-2 pb-2 text-xs">
        {t("search.resultCount", { count: totalCount })}
      </p>
      {summary.visible && (
        <SearchSummaryItem
          isOpeningChat={summary.isOpeningChat}
          onCitationClick={(citationId) => {
            const hit = hits.find((item) => item.id === citationId);
            if (hit) {
              onOpenResult(hit);
            }
          }}
          onClick={summary.onSummarize}
          onOpenChat={summary.onOpenChat}
          summarizeMutation={summary.summarizeMutation}
        />
      )}
      <div className="relative" style={{ height: `${virtual.totalSize}px` }}>
        {virtual.items.map((virtualHit) => {
          const hit = hits.at(virtualHit.index);
          if (!hit) {
            return null;
          }
          return (
            <div
              className="absolute inset-x-0 top-0"
              data-index={virtualHit.index}
              key={hit.id}
              ref={virtual.measureElement}
              style={{ transform: `translateY(${virtualHit.start}px)` }}
            >
              <SearchResultItem
                hit={hit}
                index={virtualHit.index}
                onClick={onOpenResult}
                resultNumber={virtualHit.index + 1}
              />
            </div>
          );
        })}
      </div>
      {(pagination.hasNextPage || pagination.isFetchNextPageError) && (
        <div
          className="flex h-10 items-center justify-center px-2 pt-2"
          ref={
            pagination.isFetchNextPageError ? undefined : pagination.loadMoreRef
          }
        >
          {pagination.isFetchNextPageError && (
            <Button
              onClick={() => {
                detached(
                  pagination.fetchNextPage(),
                  "search-dialog.fetch-next-page",
                );
              }}
              size="sm"
              variant="outline"
            >
              {t("common.retry")}
            </Button>
          )}
          {!pagination.isFetchNextPageError &&
            pagination.isFetchingNextPage && (
              <LoaderIcon className="text-muted-foreground size-4 animate-spin" />
            )}
          {!pagination.isFetchNextPageError &&
            !pagination.isFetchingNextPage && (
              <span className="sr-only">{t("common.loadMore")}</span>
            )}
        </div>
      )}
    </div>
  );
};
