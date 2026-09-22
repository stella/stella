import { useRef, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import type { FacetSourceBucket } from "@/components/public-law-table/public-law-facets.logic";
import { PublicLawPager } from "@/components/public-law-table/public-law-pager";
import {
  publicLawPageIndex,
  publicLawPageNumber,
  publicLawPagerModel,
  publicLawPageSearchSchema,
  publicLawPageSearchValue,
  publicLawPageSize,
  publicLawPageSizeSearchSchema,
  publicLawPageSizeSearchValue,
  publicLawPagesToWalk,
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
import {
  STATUTE_FILTER_KEYS,
  StatuteFilterPopover,
} from "@/features/statutes/components/statute-filter-popover";
import type { StatuteFilterKey } from "@/features/statutes/components/statute-filter-popover";
import { StatuteSearch } from "@/features/statutes/components/statute-search";
import {
  StatuteTable,
  useStatuteColumnGroups,
} from "@/features/statutes/components/statute-table";
import {
  createStatuteFilters,
  readStatuteIntent,
} from "@/features/statutes/open-statute-match";
import {
  statuteFacetsOptions,
  statutesInfiniteOptions,
} from "@/features/statutes/queries/statutes";
import type {
  StatuteListFilters,
  StatuteListItem,
} from "@/features/statutes/queries/statutes";
import { STATUTE_VALIDITY_LABEL_KEYS } from "@/features/statutes/statute-columns.logic";
import type { StatuteQueryIntent } from "@/features/statutes/statute-query-intent";
import {
  useStatuteColumnPreferences,
  useStatuteFind,
} from "@/features/statutes/use-statute-table";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import {
  ensureRouteInfiniteQueryData,
  prefetchRouteQuery,
} from "@/lib/react-query";
import {
  createStatuteIndexPath,
  createStatutePath,
  createStatuteRouteParams,
  isPublicStatuteCountry,
} from "@/lib/statute-route";

/** What the route accepts in `q`, and therefore what the field may hold. */
const MAX_QUERY_LENGTH = 256;

/** Stable empties, so an unchanged page does not hand the table new arrays. */
const EMPTY_STATUTES: readonly StatuteListItem[] = [];
const NO_TYPES: readonly FacetSourceBucket[] = [];

const optionalStringSchema = (maxLength: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(maxLength),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  );

const searchSchema = v.object({
  page: publicLawPageSearchSchema,
  pageSize: publicLawPageSizeSearchSchema,
  q: optionalStringSchema(MAX_QUERY_LENGTH),
  type: optionalStringSchema(128),
  // A link is public and may be edited by hand or by a crawler; a status this
  // build does not know is not an error page, it is every status.
  validity: v.fallback(
    v.optional(v.picklist(LEGISLATION_LIST_VALIDITIES)),
    undefined,
  ),
});

type StatutesIndexSearch = v.InferOutput<typeof searchSchema>;

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

/** What the list asks the corpus for: the entry, narrowed by the filters. */
const createStatuteListFilters = (
  country: string,
  search: StatutesIndexSearch,
): StatuteListFilters => ({
  ...createStatuteFilters(country, readStatuteIntent(country, search.q)),
  ...(search.type === undefined ? {} : { documentType: search.type }),
  ...(search.validity === undefined ? {} : { validity: search.validity }),
});

const activeStatuteFilterCount = (search: StatutesIndexSearch): number =>
  STATUTE_FILTER_KEYS.filter((key) => search[key] !== undefined).length;

const createStatutesIndexPath = (
  country: string,
  { q }: StatutesIndexSearch,
): `/law/${string}` => {
  const path = createStatuteIndexPath(country);

  return q ? `${path}?q=${encodeURIComponent(q)}` : path;
};

/**
 * The page the document describes: its rows are what the crawler reads and
 * what the collection markup lists.
 */
const shownStatutes = (
  walked: { pages: readonly { items: StatuteListItem[] }[] } | undefined,
  page: number | undefined,
): StatuteListItem[] => {
  if (walked === undefined) {
    return [];
  }
  const shown = walked.pages.at(
    publicLawPageIndex(publicLawPageNumber(page), walked.pages.length),
  );
  return shown ? shown.items : [];
};

export const Route = createFileRoute("/law/$country/statutes/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps, params }) => {
    if (!isPublicStatuteCountry(params.country)) {
      notFound({ throw: true });
    }
    const options = statutesInfiniteOptions(
      createStatuteListFilters(params.country, deps),
      publicLawPageSize(deps.pageSize),
    );
    // The corpus answers with cursors, so a deep link walks the chain to the
    // page it names; the pager's links are real addresses.
    const walked =
      queryClient.getQueryData(options.queryKey)?.pages.length ?? 0;
    const wanted = publicLawPageNumber(deps.page);
    const [pages] = await Promise.all([
      ensureRouteInfiniteQueryData(queryClient, {
        ...options,
        ...(wanted > 1 &&
          wanted > walked && { pages: publicLawPagesToWalk(wanted, walked) }),
      }),
      // The type filter's choices: warm, never awaited, so a slow facet read
      // cannot hold the list back.
      prefetchRouteQuery(
        queryClient,
        statuteFacetsOptions(params.country.toUpperCase()),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      ),
    ]);

    return { statutes: shownStatutes(pages, deps.page) };
  },
  head: ({ loaderData, match, params }) => {
    const title = pageTitle("statutes.title");
    const description =
      "Public database of consolidated statutes, indexable by act and version.";
    const path = createStatutesIndexPath(params.country, match.search);

    return createPublicLawHead({
      description,
      jsonLd: createLegalCollectionJsonLd({
        aboutName: "Statutes",
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
        search: (previous) => ({
          ...previous,
          page: undefined,
          q: value.trim() ? value : undefined,
        }),
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
        nextSearch({
          ...previous,
          ...(pending === null ? {} : { q: pending || undefined }),
          page: undefined,
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
        maxLength={MAX_QUERY_LENGTH}
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
      <span>{t("caseLaw.pagination.page", { page: String(page) })}</span>
      {intent.type === "act" && intent.label !== null && (
        <span>{t("statutes.resolvedAlias", { label: intent.label })}</span>
      )}
    </p>
  );
}
