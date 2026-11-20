import { useRef, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { createStatuteRouteParams } from "@stll/api-contract/statute-route";

import type { FacetSourceBucket } from "@/components/public-law-table/public-law-facets.logic";
import {
  FacetSection,
  PublicLawFilterPopover,
} from "@/components/public-law-table/public-law-filter-popover";
import { PublicLawPager } from "@/components/public-law-table/public-law-pager";
import {
  publicLawPageNumber,
  publicLawPagerModel,
  publicLawPageSearchValue,
  publicLawPageSize,
  publicLawPageSizeSearchValue,
} from "@/components/public-law-table/public-law-pagination.logic";
import type { PublicLawPageSize } from "@/components/public-law-table/public-law-pagination.logic";
import {
  PublicLawFilterChips,
  PublicLawResultsToolbar,
} from "@/components/public-law-table/public-law-results-toolbar";
import type { PublicLawFilterChip } from "@/components/public-law-table/public-law-results-toolbar";
import { usePublicLawPageArrival } from "@/components/public-law-table/use-public-law-page-arrival";
import { TableFindBar } from "@/components/workspaces/table/table-find-bar";
import { StatuteDisplayLabel } from "@/features/statutes/components/statute-display-label";
import { StatuteFilterPopover } from "@/features/statutes/components/statute-filter-popover";
import { StatuteSearch } from "@/features/statutes/components/statute-search";
import { StatuteSearchResults } from "@/features/statutes/components/statute-search-results";
import {
  StatuteTable,
  useStatuteColumnGroups,
} from "@/features/statutes/components/statute-table";
import { createStatuteFilters } from "@/features/statutes/open-statute-match";
import { useOpenStatuteTab } from "@/features/statutes/open-statute-tab";
import {
  statuteFacetsOptions,
  statuteSearchInfiniteOptions,
  statutesInfiniteOptions,
} from "@/features/statutes/queries/statutes";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import { STATUTE_VALIDITY_LABEL_KEYS } from "@/features/statutes/statute-columns.logic";
import {
  activeStatuteFilterCount,
  withStatuteFilter,
} from "@/features/statutes/statute-filters.logic";
import type { StatuteFilterKey } from "@/features/statutes/statute-filters.logic";
import {
  changeStatutesIndexQuery,
  readStatuteIntent,
  STATUTE_MAX_QUERY_LENGTH,
  type StatutesIndexSearch,
} from "@/features/statutes/statute-index-search.logic";
import { statuteColumnOrder } from "@/features/statutes/statute-order.logic";
import {
  useStatuteColumnPreferences,
  useStatuteFind,
} from "@/features/statutes/use-statute-table";
import { useHydrated } from "@/hooks/use-hydrated";
import type { TranslationKey } from "@/i18n/types";
import {
  searchTiming,
  useSearchResultsTiming,
} from "@/lib/analytics/search-timing";
import { detached } from "@/lib/detached";
import { queryView, routeRowsPhase } from "@/lib/query-view.logic";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";
import type { RouteState } from "@/routes/-route-pending-view";
import {
  PublicLawQueryFeedback,
  PublicLawResultsBoundary,
} from "@/routes/law/-components/public-law-list-failure";
import { createStatuteListFilters } from "@/routes/law/-statutes-index.logic";

import { StatuteFullTextLayout, StatuteListLayout } from "./-index.pending";

// The statutes list page, the route's component. It renders the shell its
// pending view renders (`-index.pending.tsx`), with the live controls in the
// places the faces held.

const STATUTES_INDEX_PATH = "/law/$country/statutes/";

const routeApi = getRouteApi(STATUTES_INDEX_PATH);

/** Stable empties, so an unchanged page does not hand the table new arrays. */
const EMPTY_STATUTES: readonly StatuteListItem[] = [];
const NO_TYPES: readonly FacetSourceBucket[] = [];

/** Which facet a chip belongs to, for the label the chip carries. */
const FILTER_KIND_LABEL_KEYS = {
  type: "common.type",
  validity: "common.status",
  year: "workspaces.views.calendar.year",
} as const satisfies Record<StatuteFilterKey, TranslationKey>;

/** The page renders only once the router has the route's data. */
const ROUTE_STATE: RouteState = "loaded";

export function PublicStatutesIndex() {
  const country = routeApi.useParams({
    select: ({ country: routeCountry }) => routeCountry,
  });
  const q = routeApi.useSearch({ select: ({ q: routeQuery }) => routeQuery });
  const intent = readStatuteIntent(country, q);
  return intent.type === "text" ? (
    <PublicStatuteFullText key={country} query={intent.text} />
  ) : (
    <PublicStatuteList />
  );
}

function PublicStatuteFullText({ query }: { query: string }) {
  const openStatute = useOpenStatuteTab(query);
  const hydrated = useHydrated();
  const t = useTranslations();
  const country = routeApi.useParams({
    select: ({ country: routeCountry }) => routeCountry,
  });
  const search = routeApi.useSearch({
    select: ({ asOf, q, type }) => ({ asOf, q, type }),
  });
  const navigate = routeApi.useNavigate();
  const [input, setInput] = useState(query);
  const [requestedQuery, setRequestedQuery] = useState(query);
  const [syncedQuery, setSyncedQuery] = useState(query);
  if (syncedQuery !== query) {
    setSyncedQuery(query);
    if (query !== requestedQuery) {
      setInput(query);
    }
  }
  const writeQuery = useDebouncedCallback((value: string) => {
    searchTiming.requested("legislation", value);
    detached(
      navigate({
        replace: true,
        search: (previous) =>
          changeStatutesIndexQuery({ country, previous, query: value }),
      }),
      "statutes.full-text-navigate",
    );
  }, 300);
  const dataQuery = useInfiniteQuery({
    ...statuteSearchInfiniteOptions({
      ...(search.asOf === undefined ? {} : { asOf: search.asOf }),
      country: country.toUpperCase(),
      query,
      ...(search.type === undefined ? {} : { documentType: search.type }),
    }),
    enabled: hydrated,
  });
  useSearchResultsTiming(
    "legislation",
    search.q ?? "",
    dataQuery.data !== undefined && !dataQuery.isPlaceholderData,
  );
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isPending } =
    dataQuery;
  const dataView = queryView(dataQuery, {
    isEmpty: (data) => data.pages.every((page) => page.items.length === 0),
  });
  const data = dataView.type === "items" ? dataView.items : undefined;
  const facetsQuery = useQuery(statuteFacetsOptions(country.toUpperCase()));
  const facetsView = queryView(facetsQuery);
  useQueryViewError(facetsView, "PublicStatuteFullText:query");
  const facets = facetsView.type === "items" ? facetsView.items : undefined;
  const selectType = (documentType: string | undefined) => {
    const pending = writeQuery.isPending() ? input.trim() : query;
    writeQuery.cancel();
    detached(
      navigate({
        replace: true,
        search: (previous) => ({
          ...changeStatutesIndexQuery({ country, previous, query: pending }),
          type: documentType,
        }),
      }),
      "statutes.full-text-filter",
    );
  };
  const hits =
    data === undefined ? [] : data.pages.flatMap((page) => page.items);
  return (
    <StatuteFullTextLayout
      title={t("statutes.title")}
      feedback={
        hydrated &&
        dataView.type !== "pending" && (
          <PublicLawQueryFeedback view={dataView} />
        )
      }
      search={
        <StatuteSearch
          country={country}
          maxLength={STATUTE_MAX_QUERY_LENGTH}
          query={input}
          onQueryChange={(value) => {
            setInput(value);
            setRequestedQuery(value.trim());
            writeQuery(value);
          }}
          onSubmit={() => writeQuery.flush()}
        />
      }
      filters={
        <PublicLawFilterPopover
          activeFilterCount={search.type === undefined ? 0 : 1}
        >
          <FacetSection
            buckets={facets?.documentType ?? NO_TYPES}
            heading={t("common.type")}
            name="type"
            onSelect={selectType}
            selectedValue={search.type}
          />
        </PublicLawFilterPopover>
      }
      chips={
        <PublicLawFilterChips
          chips={
            search.type === undefined
              ? []
              : [
                  {
                    id: "filter:type",
                    kind: t("common.type"),
                    value: search.type,
                    onRemove: () => selectType(undefined),
                  },
                ]
          }
          onClearAll={() => selectType(undefined)}
        />
      }
      results={
        dataView.type !== "error" && (
          <PublicLawResultsBoundary
            searchKey={`${country}:${query}`}
            resetOn={data}
          >
            <StatuteSearchResults
              hits={hits}
              isLoading={isPending}
              isFetchingNextPage={isFetchingNextPage}
              hasNextPage={hasNextPage}
              onLoadMore={() =>
                detached(fetchNextPage(), "statutes.full-text-next-page")
              }
              titleLink={(hit) => {
                const params = createStatuteRouteParams({
                  country: hit.country,
                  documentId: hit.documentId,
                  eli: hit.eli,
                  slug: hit.slug,
                  version: null,
                });
                return (
                  <Link
                    to="/law/$country/statutes/$slug"
                    params={{ country: params.country, slug: params.slug }}
                    search={{ q: query }}
                    onClick={openStatute.onLinkClick({
                      ...hit,
                      id: toSafeId<"legislationDocument">(hit.documentId),
                      versionValidFrom: null,
                    })}
                  >
                    <StatuteDisplayLabel statute={hit} />
                  </Link>
                );
              }}
            />
          </PublicLawResultsBoundary>
        )
      }
    />
  );
}

/** The page and the alias the entry resolved to, held during a refresh. */
const StatuteListHeading = ({
  alias,
  isRefreshing,
  page,
}: {
  alias: string | null;
  isRefreshing: boolean;
  page: number;
}) => {
  const t = useTranslations();
  return (
    <p
      aria-busy={isRefreshing}
      className="flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums transition-opacity duration-200 aria-busy:opacity-56"
    >
      <span>{t("common.page", { page: String(page) })}</span>
      {alias !== null && (
        <span>{t("statutes.resolvedAlias", { label: alias })}</span>
      )}
    </p>
  );
};

type StatuteListFilterChipsOptions = {
  search: StatutesIndexSearch;
  onRemove: (key: "year" | "validity" | "type") => void;
};

const useStatuteListFilterChips = ({
  search,
  onRemove,
}: StatuteListFilterChipsOptions) => {
  const t = useTranslations();
  const chips: PublicLawFilterChip[] = [];
  if (search.year !== undefined) {
    chips.push({
      id: "filter:year",
      kind: t(FILTER_KIND_LABEL_KEYS.year),
      onRemove: () => onRemove("year"),
      value: search.year,
    });
  }
  if (search.validity !== undefined) {
    chips.push({
      id: "filter:validity",
      kind: t(FILTER_KIND_LABEL_KEYS.validity),
      onRemove: () => onRemove("validity"),
      value: t(STATUTE_VALIDITY_LABEL_KEYS[search.validity]),
    });
  }
  if (search.type !== undefined) {
    chips.push({
      id: "filter:type",
      kind: t(FILTER_KIND_LABEL_KEYS.type),
      onRemove: () => onRemove("type"),
      value: search.type,
    });
  }

  return chips;
};

/**
 * The headers' part in the list's order. A header orders the list only while
 * a year bounds it; the address keeps the order, and a new order starts again
 * at page one, since the cursors were cut for the old one.
 */
const useStatuteListOrder = ({
  order,
  year,
}: Pick<StatutesIndexSearch, "order" | "year">) => {
  const t = useTranslations();
  const navigate = routeApi.useNavigate();
  return statuteColumnOrder({
    sort: order,
    year,
    needsYearReason: t("statutes.sortNeedsYear"),
    onSortChange: (next) => {
      detached(
        navigate({
          search: (previous) => ({ ...previous, page: undefined, order: next }),
        }),
        "statutes.sort-navigate",
      );
    },
  });
};

/** The rows phase of the statute walk, counting the rows its held pages carry. */
const statuteRowsPhase = (query: {
  data: { pages: readonly { items: readonly unknown[] }[] } | undefined;
  isLoading: boolean;
  isPlaceholderData: boolean;
}) =>
  routeRowsPhase({
    isLoading: query.isLoading,
    isPlaceholderData: query.isPlaceholderData,
    keptRowCount:
      query.data === undefined
        ? 0
        : query.data.pages.reduce(
            (count, page) => count + page.items.length,
            0,
          ),
    routeState: ROUTE_STATE,
  });

/** One page of the list, as this route addresses it; the rest of the URL travels. */
const statutesPageLink = ({ label, page }: { label: string; page: number }) => (
  <Link
    aria-label={label}
    from={STATUTES_INDEX_PATH}
    search={(previous) => ({
      ...previous,
      page: publicLawPageSearchValue(page),
    })}
    to="."
  />
);

function PublicStatuteList() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const country = routeApi.useParams({ select: (params) => params.country });
  const search = routeApi.useSearch({
    select: ({ page, pageSize, q, order, type, validity, year }) => ({
      page,
      pageSize,
      q,
      order,
      type,
      validity,
      year,
    }),
  });
  const navigate = routeApi.useNavigate();
  const { layout, setLayout } = useStatuteColumnPreferences(country);

  const [queryInput, setQueryInput] = useState(search.q ?? "");
  // What the field last asked the URL to hold. A navigation that lands on
  // this value is the field's own write coming back, not somebody else's.
  const [requestedQuery, setRequestedQuery] = useState(search.q ?? "");
  const writeQuery = useDebouncedCallback((value: string) => {
    searchTiming.requested("legislation", value);
    detached(
      navigate({
        replace: true,
        search: (previous) =>
          changeStatutesIndexQuery({ country, previous, query: value }),
      }),
      "statutes.search-navigate",
    );
  }, 300);
  const handleQueryChange = (value: string) => {
    setQueryInput(value);
    setRequestedQuery(value.trim());
    writeQuery(value);
  };
  // Resync the field when the route query changes underneath it, e.g. the
  // navigation back to this list drops `q`. Adjust state during render (the
  // React-sanctioned pattern) instead of an effect.
  const [syncedQuery, setSyncedQuery] = useState(search.q);
  if (syncedQuery !== search.q) {
    setSyncedQuery(search.q);
    if ((search.q ?? "") !== requestedQuery) {
      setQueryInput(search.q ?? "");
    }
  }

  // The results column — toolbar, chips and grid: what a Cmd/Ctrl+F inside
  // belongs to.
  const paneRef = useRef<HTMLDivElement>(null);

  const intent = readStatuteIntent(country, search.q);
  const pageSize = publicLawPageSize(search.pageSize);
  const statutesOptions = statutesInfiniteOptions(
    createStatuteListFilters(country, search),
    pageSize,
  );
  const dataQuery = useInfiniteQuery({
    ...statutesOptions,
    // The chain the reader has walked stays loaded while the filters change,
    // so stepping between pages never blanks the table.
    placeholderData: keepPreviousData,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData } =
    dataQuery;
  useSearchResultsTiming(
    "legislation",
    search.q ?? "",
    dataQuery.data !== undefined && !isPlaceholderData,
  );
  const dataView = queryView(dataQuery, {
    isEmpty: (data) => data.pages.every((page) => page.items.length === 0),
  });
  const data = dataView.type === "items" ? dataView.items : undefined;
  const facetsQuery = useQuery({
    ...statuteFacetsOptions(country.toUpperCase()),
    placeholderData: keepPreviousData,
  });
  const facetsView = queryView(facetsQuery);
  useQueryViewError(facetsView, "PublicStatuteList:query");
  const facets = facetsView.type === "items" ? facetsView.items : undefined;
  const rows = statuteRowsPhase(dataQuery);

  const walkedPageCount = data?.pages.length ?? 0;
  const pager = publicLawPagerModel({
    hasNextPage,
    page: publicLawPageNumber(search.page),
    walkedPageCount,
  });
  const statutes: readonly StatuteListItem[] =
    data?.pages.at(pager.currentPage - 1)?.items ?? EMPTY_STATUTES;
  // A page the reader steps to brings them to its first row once it is drawn.
  const requestPage = usePublicLawPageArrival({
    focusOnArrival: "first-result",
    regionRef: paneRef,
    shownPage: rows === "rows" ? pager.currentPage : null,
  });
  const find = useStatuteFind({
    layout,
    paneRef,
    statutes,
    surfaceKey: country,
  });
  const columnGroups = useStatuteColumnGroups();
  const order = useStatuteListOrder(search);

  // A pending debounced query write holds text the URL has not seen yet;
  // it is folded in first so a filter change cannot drop the edit. Every such
  // change also drops the page: the cursors were cut for the old result set.
  const searchNavigation = async (
    nextSearch: (previous: StatutesIndexSearch) => StatutesIndexSearch,
  ) => {
    const pending = writeQuery.isPending() ? queryInput.trim() : null;
    writeQuery.cancel();
    await navigate({
      replace: true,
      search: (previous) =>
        changeStatutesIndexQuery({
          country,
          previous: nextSearch(previous),
          query: pending ?? previous.q ?? "",
        }),
    });
  };

  const selectFacet = (key: StatuteFilterKey, value: string | undefined) => {
    detached(
      searchNavigation((previous) => withStatuteFilter(previous, key, value)),
      "statutes.filter-navigate",
    );
  };

  const setPageSize = (next: PublicLawPageSize) => {
    detached(
      searchNavigation((previous) => ({
        ...previous,
        pageSize: publicLawPageSizeSearchValue(next),
      })),
      "statutes.page-size-navigate",
    );
  };

  /**
   * The page after the chain: its cursor is the one the last walked page
   * named, so it is fetched first and only then does the URL move on to it.
   */
  const walkForward = () => {
    detached(
      (async () => {
        const result = await fetchNextPage();
        const walked = result.data?.pages.length ?? walkedPageCount;
        if (walked <= walkedPageCount) {
          return;
        }
        requestPage(walked);
        await navigate({
          search: (previous) => ({
            ...previous,
            page: publicLawPageSearchValue(walked),
          }),
        });
      })(),
      "statutes.walk-next-page",
    );
  };

  const chips = useStatuteListFilterChips({
    search,
    onRemove: (key) =>
      detached(
        searchNavigation((previous) => ({ ...previous, [key]: undefined })),
        "statutes.filter-navigate",
      ),
  });

  // Enter on an act reference opens the act when exactly one work answers
  // to it. Several (the same number in two collections) stay listed, so the
  // reader picks; nothing is guessed. The field's value is read directly:
  // the debounced URL write may still be pending.
  const openSingleMatch = () => {
    const submitted = readStatuteIntent(
      country,
      queryInput.trim() || undefined,
    );
    if (submitted.type !== "act") {
      return;
    }
    writeQuery.flush();
    detached(
      (async () => {
        const pages = await ensureRouteInfiniteQueryData(
          queryClient,
          statutesInfiniteOptions(createStatuteFilters(country, submitted)),
        );
        const only = pages.pages.at(0)?.items;
        if (only?.length !== 1) {
          return;
        }
        const statute = only.at(0);
        if (statute === undefined) {
          return;
        }
        const params = createStatuteRouteParams({
          country: statute.country,
          documentId: statute.id,
          eli: statute.eli,
          slug: statute.slug,
          version: null,
        });
        await navigate({
          params: { country: params.country, slug: params.slug },
          search:
            submitted.provision === null ? {} : { jump: submitted.provision },
          to: "/law/$country/statutes/$slug",
        });
      })(),
      "statutes.open-match",
    );
  };

  return (
    <StatuteListLayout
      title={t("statutes.title")}
      chips={
        <PublicLawFilterChips
          chips={chips}
          onClearAll={() => {
            // Clear the filters, not the entry the reader typed into the box.
            detached(
              searchNavigation((previous) => ({
                ...previous,
                type: undefined,
                validity: undefined,
                year: undefined,
              })),
              "statutes.clear-filters",
            );
          }}
        />
      }
      feedback={
        dataView.type === "pending" ? null : (
          <PublicLawQueryFeedback view={dataView} />
        )
      }
      pager={
        <PublicLawPager
          navigation={{
            type: "chain",
            model: pager,
            isWalking: isFetchingNextPage,
            onWalkForward: walkForward,
          }}
          onPageRequest={requestPage}
          onPageSizeChange={setPageSize}
          pageLink={statutesPageLink}
          pageSize={pageSize}
        />
      }
      paneRef={paneRef}
      results={
        dataView.type === "error" ? null : (
          <PublicLawResultsBoundary
            resetOn={data}
            searchKey={`${country}:${search.q ?? ""}:${search.type ?? ""}:${search.validity ?? ""}:${search.year ?? ""}:${search.order ?? ""}`}
          >
            <StatuteTable
              emptyState={
                <p className="text-muted-foreground p-4 text-sm">
                  {t("statutes.emptyState")}
                </p>
              }
              expectedRowCount={pageSize}
              findHighlight={find.highlight}
              firstRowNumber={(pager.currentPage - 1) * pageSize + 1}
              isLoading={rows === "skeleton"}
              isRefreshing={rows === "stale"}
              layout={layout}
              onLayoutChange={setLayout}
              order={order}
              statutes={find.rows}
            />
          </PublicLawResultsBoundary>
        )
      }
      search={
        <StatuteSearch
          country={country}
          maxLength={STATUTE_MAX_QUERY_LENGTH}
          onQueryChange={handleQueryChange}
          onSubmit={openSingleMatch}
          query={queryInput}
        />
      }
      toolbar={
        <PublicLawResultsToolbar
          columnGroups={columnGroups}
          filters={
            <StatuteFilterPopover
              activeFilterCount={activeStatuteFilterCount(search)}
              onSelect={selectFacet}
              selection={search}
              types={facets?.documentType ?? NO_TYPES}
            />
          }
          find={<TableFindBar {...find.bar} />}
          layout={layout}
          onLayoutChange={setLayout}
          summary={
            <StatuteListHeading
              alias={
                intent.type === "act" && intent.label !== null
                  ? intent.label
                  : null
              }
              isRefreshing={rows === "stale"}
              page={pager.currentPage}
            />
          }
        />
      }
    />
  );
}
