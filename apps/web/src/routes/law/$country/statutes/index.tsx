import { useRef, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";
import type { StatuteQueryIntent } from "@stll/api-contract/statute-query-intent";
import {
  createStatuteIndexPath,
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";
import { ScrollArea } from "@stll/ui/scroll-area";

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
  publicLawPagesToWalk,
  reachablePublicLawPage,
} from "@/components/public-law-table/public-law-pagination.logic";
import type { PublicLawPageSize } from "@/components/public-law-table/public-law-pagination.logic";
import { publicLawRowsPhase } from "@/components/public-law-table/public-law-results-state.logic";
import type { PublicLawRouteState } from "@/components/public-law-table/public-law-results-state.logic";
import {
  PublicLawFilterChips,
  PublicLawResultsToolbar,
} from "@/components/public-law-table/public-law-results-toolbar";
import type { PublicLawFilterChip } from "@/components/public-law-table/public-law-results-toolbar";
import { TableFindBar } from "@/components/workspaces/table/table-find-bar";
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
import { STATUTE_FILTER_KEYS } from "@/features/statutes/statute-filters.logic";
import type { StatuteFilterKey } from "@/features/statutes/statute-filters.logic";
import {
  changeStatutesIndexQuery,
  readStatuteIntent,
  STATUTE_MAX_QUERY_LENGTH,
  statutesIndexSearchSchema,
  type StatutesIndexSearch,
} from "@/features/statutes/statute-index-search.logic";
import {
  useStatuteColumnPreferences,
  useStatuteFind,
} from "@/features/statutes/use-statute-table";
import { useHydrated } from "@/hooks/use-hydrated";
import { getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { isPublicStatuteCountry } from "@/lib/statute-route";
import {
  createStatuteListFilters,
  loadPublicStatutesIndex,
} from "@/routes/law/-statutes-index.logic";

/** Stable empties, so an unchanged page does not hand the table new arrays. */
const EMPTY_STATUTES: readonly StatuteListItem[] = [];
const NO_TYPES: readonly FacetSourceBucket[] = [];

/** Which facet a chip belongs to, for the label the chip carries. */
const FILTER_KIND_LABEL_KEYS = {
  type: "common.type",
  validity: "common.status",
} as const satisfies Record<StatuteFilterKey, TranslationKey>;

/**
 * The URL with one facet set or unset. Written out per key rather than by a
 * computed property, so a filter key that is not in the search schema cannot
 * be navigated to.
 */
const withFilter = (
  previous: StatutesIndexSearch,
  key: StatuteFilterKey,
  value: string | undefined,
): StatutesIndexSearch => {
  switch (key) {
    case "type":
      return { ...previous, type: value };
    case "validity":
      return {
        ...previous,
        validity: LEGISLATION_LIST_VALIDITIES.find(
          (validity) => validity === value,
        ),
      };
    default:
      key satisfies never;
      return panic(`Unhandled statute filter: ${String(key)}`);
  }
};

const activeStatuteFilterCount = (search: StatutesIndexSearch): number =>
  STATUTE_FILTER_KEYS.filter((key) => search[key] !== undefined).length;

const createStatutesIndexPath = (
  country: string,
  { q }: StatutesIndexSearch,
): `/law/${string}` => {
  const path = createStatuteIndexPath(country);

  return q ? `${path}?q=${encodeURIComponent(q)}` : path;
};

export const Route = createFileRoute("/law/$country/statutes/")({
  validateSearch: statutesIndexSearchSchema,
  loaderDeps: ({ search }) => search,
  // A page the chain of cursors does not reach redirects to the deepest one
  // that does, as the case-law results do: server-side, so a crawler and a
  // no-JS reader get a real redirect instead of page 3 under a page-40 URL.
  beforeLoad: async ({ context: { queryClient }, params, search }) => {
    if (!isPublicStatuteCountry(params.country)) {
      notFound({ throw: true });
      return;
    }
    if (readStatuteIntent(params.country, search.q).type === "text") {
      return;
    }
    const options = statutesInfiniteOptions(
      createStatuteListFilters(params.country, search),
      publicLawPageSize(search.pageSize),
    );
    const walked =
      queryClient.getQueryData(options.queryKey)?.pages.length ?? 0;
    const wanted = publicLawPageNumber(search.page);
    // Only a deep arrival pays for the walk; the loader decides whether any
    // other navigation is worth awaiting.
    let reached = walked;
    if (wanted > 1 && wanted > walked) {
      const chain = await ensureRouteInfiniteQueryData(queryClient, {
        ...options,
        pages: publicLawPagesToWalk(wanted, walked),
      });
      reached = chain.pages.length;
    }
    const page = publicLawPageSearchValue(
      reachablePublicLawPage(wanted, reached),
    );
    if (search.page !== page) {
      redirect({
        to: "/law/$country/statutes",
        params: { country: params.country },
        search: { ...search, page },
        replace: true,
        throw: true,
      });
    }
  },
  loader: async ({ cause, context: { queryClient }, deps, params }) =>
    await loadPublicStatutesIndex({
      cause,
      country: params.country,
      queryClient,
      search: deps,
    }),
  head: ({ loaderData, match, params }) => {
    const t = getTranslator();
    const title = pageTitle("statutes.title");
    const description = t("statutes.description");
    const path = createStatutesIndexPath(params.country, match.search);

    return createPublicLawHead({
      description,
      indexing: match.search.q === undefined ? "default" : "noindex",
      jsonLd: createLegalCollectionJsonLd({
        t,
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "statutes",
        items: loaderData
          ? loaderData.statutes.map((statute) => ({
              name: statute.title,
              url: createPublicLawCanonicalUrl(
                createStatutePath(
                  createStatuteRouteParams({
                    country: statute.country,
                    documentId: statute.id,
                    eli: statute.eli,
                    slug: statute.slug,
                    version: null,
                  }),
                ),
              ),
            }))
          : [],
        name: title,
      }),
      path,
      title,
      type: "website",
    });
  },
  // One page, two states, as the case-law results: only a cold arrival
  // renders the pending one, and what waits there is the grid alone.
  component: () => <PublicStatutesIndex routeState="loaded" />,
  pendingComponent: () => <PublicStatutesIndex routeState="pending" />,
});

function PublicStatutesIndex({
  routeState,
}: {
  routeState: PublicLawRouteState;
}) {
  const country = Route.useParams({
    select: ({ country: routeCountry }) => routeCountry,
  });
  const q = Route.useSearch({ select: ({ q: routeQuery }) => routeQuery });
  const intent = readStatuteIntent(country, q);
  return intent.type === "text" ? (
    <PublicStatuteFullText key={country} query={intent.text} />
  ) : (
    <PublicStatuteList routeState={routeState} />
  );
}

function PublicStatuteFullText({ query }: { query: string }) {
  const openStatute = useOpenStatuteTab(query);
  const hydrated = useHydrated();
  const t = useTranslations();
  const country = Route.useParams({
    select: ({ country: routeCountry }) => routeCountry,
  });
  const search = Route.useSearch({ select: ({ type }) => ({ type }) });
  const navigate = Route.useNavigate();
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
    detached(
      navigate({
        replace: true,
        search: (previous) =>
          changeStatutesIndexQuery({ country, previous, query: value }),
      }),
      "statutes.full-text-navigate",
    );
  }, 300);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } =
    useInfiniteQuery({
      ...statuteSearchInfiniteOptions({
        country: country.toUpperCase(),
        query,
        ...(search.type === undefined ? {} : { documentType: search.type }),
      }),
      enabled: hydrated,
      throwOnError: true,
    });
  const { data: facets } = useQuery(
    statuteFacetsOptions(country.toUpperCase()),
  );
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
    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <h1 className="sr-only">{t("statutes.title")}</h1>
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
      <ScrollArea className="min-h-0 flex-1">
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
                {hit.title}
              </Link>
            );
          }}
        />
      </ScrollArea>
    </main>
  );
}

function PublicStatuteList({
  routeState,
}: {
  routeState: PublicLawRouteState;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const country = Route.useParams({ select: (params) => params.country });
  const search = Route.useSearch({
    select: ({ page, pageSize, q, type, validity }) => ({
      page,
      pageSize,
      q,
      type,
      validity,
    }),
  });
  const navigate = Route.useNavigate();
  const { layout, setLayout } = useStatuteColumnPreferences(country);

  const [queryInput, setQueryInput] = useState(search.q ?? "");
  // What the field last asked the URL to hold. A navigation that lands on
  // this value is the field's own write coming back, not somebody else's.
  const [requestedQuery, setRequestedQuery] = useState(search.q ?? "");
  const writeQuery = useDebouncedCallback((value: string) => {
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
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isPlaceholderData,
  } = useInfiniteQuery({
    ...statutesOptions,
    // The chain the reader has walked stays loaded while the filters change,
    // so stepping between pages never blanks the table.
    placeholderData: keepPreviousData,
  });
  const { data: facets } = useQuery({
    ...statuteFacetsOptions(country.toUpperCase()),
    placeholderData: keepPreviousData,
  });
  const rows = publicLawRowsPhase({ isLoading, isPlaceholderData, routeState });

  const walkedPageCount = data?.pages.length ?? 0;
  const pager = publicLawPagerModel({
    hasNextPage,
    page: publicLawPageNumber(search.page),
    walkedPageCount,
  });
  const statutes: readonly StatuteListItem[] =
    data?.pages.at(pager.currentPage - 1)?.items ?? EMPTY_STATUTES;
  const find = useStatuteFind({
    layout,
    paneRef,
    statutes,
    surfaceKey: country,
  });
  const columnGroups = useStatuteColumnGroups();

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
      searchNavigation((previous) => withFilter(previous, key, value)),
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

  const chips: PublicLawFilterChip[] = [];
  if (search.validity !== undefined) {
    chips.push({
      id: "filter:validity",
      kind: t(FILTER_KIND_LABEL_KEYS.validity),
      onRemove: () => selectFacet("validity", undefined),
      value: t(STATUTE_VALIDITY_LABEL_KEYS[search.validity]),
    });
  }
  if (search.type !== undefined) {
    chips.push({
      id: "filter:type",
      kind: t(FILTER_KIND_LABEL_KEYS.type),
      onRemove: () => selectFacet("type", undefined),
      value: search.type,
    });
  }

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

  // The pane below claims the page's height, so on a normal viewport nothing
  // overflows here and the table owns the only scroll.
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/*
        The breadcrumb already names the screen, so the heading is for the
        document outline and for a screen reader, not for the eye.
      */}
      <h1 className="sr-only">{t("statutes.title")}</h1>

      <StatuteSearch
        country={country}
        maxLength={STATUTE_MAX_QUERY_LENGTH}
        onQueryChange={handleQueryChange}
        onSubmit={openSingleMatch}
        query={queryInput}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" ref={paneRef}>
        <PublicLawResultsToolbar
          columnGroups={columnGroups}
          filters={
            <StatuteFilterPopover
              activeFilterCount={activeStatuteFilterCount(search)}
              onSelect={selectFacet}
              selection={{ type: search.type, validity: search.validity }}
              types={facets?.documentType ?? NO_TYPES}
            />
          }
          find={<TableFindBar {...find.bar} />}
          layout={layout}
          onLayoutChange={setLayout}
          summary={
            <ListHeading
              intent={intent}
              isRefreshing={rows === "stale"}
              page={pager.currentPage}
            />
          }
        />

        <PublicLawFilterChips
          chips={chips}
          onClearAll={() => {
            // Clear the filters, not the entry the reader typed into the box.
            detached(
              searchNavigation((previous) => ({
                ...previous,
                type: undefined,
                validity: undefined,
              })),
              "statutes.clear-filters",
            );
          }}
        />

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
          statutes={find.rows}
        />
        <PublicLawPager
          isWalking={isFetchingNextPage}
          model={pager}
          onPageSizeChange={setPageSize}
          onWalkForward={walkForward}
          pageLink={({ label, page }) => (
            <Link
              aria-label={label}
              from={Route.fullPath}
              search={(previous) => ({
                ...previous,
                page: publicLawPageSearchValue(page),
              })}
              to="."
            />
          )}
          pageSize={pageSize}
        />
      </div>
    </main>
  );
}

/**
 * What the list is: the page, and the alias the entry was read as when it
 * was read as one. Fades while a new search is in flight rather than
 * blanking, as the case-law count does.
 */
function ListHeading({
  intent,
  isRefreshing,
  page,
}: {
  intent: StatuteQueryIntent;
  isRefreshing: boolean;
  page: number;
}) {
  const t = useTranslations();

  return (
    <p
      aria-busy={isRefreshing}
      className="flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums transition-opacity duration-200 aria-busy:opacity-56"
    >
      <span>{t("common.page", { page: String(page) })}</span>
      {intent.type === "act" && intent.label !== null && (
        <span>{t("statutes.resolvedAlias", { label: intent.label })}</span>
      )}
    </p>
  );
}
