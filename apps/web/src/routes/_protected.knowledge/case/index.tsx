import type { ReactElement, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@stll/ui/components/command";
import { DatePickerPopover } from "@stll/ui/components/date-picker-popover";
import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { produce } from "immer";
import { HistoryIcon, LandmarkIcon, LoaderIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useFormatter, useLocale, useTranslations } from "use-intl";
import * as v from "valibot";

import { createCaseLawDecisionRouteParam } from "@/lib/case-law-route";
import { getCourtColor } from "@/lib/court-colors";
import { optionalSearchStringSchema } from "@/lib/schema";
import {
  groupCaseLawRecentSearchesByDate,
  readCaseLawRecentSearches,
  recordCaseLawRecentSearch,
} from "@/routes/_protected.knowledge/case/-lib/case-law-recents";
import type {
  CaseLawRecentSearch,
  CaseLawRecentsScope,
} from "@/routes/_protected.knowledge/case/-lib/case-law-recents";
import { decisionsInfiniteOptions } from "@/routes/_protected.knowledge/case/-queries/decisions";
import type {
  Decision,
  DecisionListFilters,
  SearchFacets,
} from "@/routes/_protected.knowledge/case/-queries/decisions";

const searchSchema = v.object({
  q: optionalSearchStringSchema(),
  country: optionalSearchStringSchema(),
  court: optionalSearchStringSchema(),
  decisionType: optionalSearchStringSchema(),
  language: optionalSearchStringSchema(),
  sourceId: optionalSearchStringSchema(),
  dateFrom: optionalSearchStringSchema(),
  dateTo: optionalSearchStringSchema(),
});

export const Route = createFileRoute("/_protected/knowledge/case/")({
  component: CaseLawIndex,
  validateSearch: searchSchema,
});

type CaseLawRouteSearch = v.InferOutput<typeof searchSchema>;
type CaseLawFilterKey = Exclude<keyof DecisionListFilters, "search">;

const DEBOUNCE_MS = 300;
const VIRTUAL_DECISION_ESTIMATE_PX = 96;
const VIRTUAL_DECISION_OVERSCAN = 6;
const CASE_LAW_FILTER_KEYS = [
  "country",
  "court",
  "dateFrom",
  "dateTo",
  "decisionType",
  "language",
  "sourceId",
] as const satisfies CaseLawFilterKey[];

function CaseLawIndex() {
  const t = useTranslations();
  const navigate = Route.useNavigate();
  const locale = useLocale();
  const routeSearch = Route.useSearch({ select: (search) => search });
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const recentsUserId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });
  const recentsOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const recentsScope = {
    organizationId: recentsOrganizationId,
    userId: recentsUserId,
  };
  const filters = useMemo(
    () => caseLawFiltersFromSearch(routeSearch),
    [routeSearch],
  );
  const [query, setQuery] = useState(routeSearch.q ?? "");
  const [recentSearches, setRecentSearches] = useState<CaseLawRecentSearch[]>(
    () => readCaseLawRecentSearches(recentsScope),
  );

  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    const nextFilters = updateFilterValue(filters, "search", value);
    setRecentSearches(recordRecentSearchIfNeeded(nextFilters, recentsScope));
    void navigate({
      search: (prev) =>
        produce(prev, (draft) => {
          setSearchDraftValue(draft, "search", value);
        }),
    });
  }, DEBOUNCE_MS);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery(decisionsInfiniteOptions(filters));

  const decisions = useMemo<Decision[]>(
    () => data?.pages.flatMap((page) => page.decisions) ?? [],
    [data],
  );
  const facets = useMemo<SearchFacets>(
    () => data?.pages.at(0)?.facets ?? null,
    [data],
  );
  const hasTypedQuery = query.trim().length > 0;
  const hasSearchQuery = (filters.search?.trim().length ?? 0) > 0;
  const isSearchPending =
    hasTypedQuery && query.trim() !== filters.search?.trim();
  const shouldShowSkeletons =
    hasTypedQuery && (isSearchPending || (hasSearchQuery && isLoading));
  const shouldShowResults =
    hasTypedQuery && !shouldShowSkeletons && decisions.length > 0;
  const commandDecisions =
    shouldShowResults && decisions.length > 0 ? decisions : [];

  const decisionVirtualizer = useVirtualizer({
    count: decisions.length,
    enabled: hasTypedQuery,
    estimateSize: () => VIRTUAL_DECISION_ESTIMATE_PX,
    getItemKey: (index) => decisions.at(index)?.id ?? index,
    getScrollElement: () => resultsRef.current,
    overscan: VIRTUAL_DECISION_OVERSCAN,
  });
  const virtualDecisions = decisionVirtualizer.getVirtualItems();

  useEffect(() => {
    const root = resultsRef.current;
    const target = loadMoreRef.current;
    if (!hasSearchQuery || !hasNextPage || !root || !target) {
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
  }, [fetchNextPage, hasNextPage, hasSearchQuery, isFetchingNextPage]);

  const updateDateFilter = (key: CaseLawFilterKey, value: string | null) => {
    const nextFilters = updateFilterValue(filters, key, value);
    setRecentSearches(recordRecentSearchIfNeeded(nextFilters, recentsScope));
    void navigate({
      search: (prev) =>
        produce(prev, (draft) => {
          setSearchDraftValue(draft, key, value);
        }),
    });
  };

  const handleFilterLinkClick = (
    key: CaseLawFilterKey,
    value: string | null,
  ) => {
    const nextFilters = updateFilterValue(filters, key, value);
    setRecentSearches(recordRecentSearchIfNeeded(nextFilters, recentsScope));
  };

  const handleRecentSearchClick = (recent: CaseLawRecentSearch) => {
    debouncedSetSearch.cancel();
    setQuery(recent.query);
    setRecentSearches(
      recordCaseLawRecentSearch(
        recent.query,
        caseLawFiltersWithSearch(recent.filters, recent.query),
        recentsScope,
      ),
    );
  };

  const clearSearchQuery = () => {
    debouncedSetSearch.cancel();
    setQuery("");
    void navigate({
      search: (prev) =>
        produce(prev, (draft) => {
          draft.q = undefined;
        }),
    });
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Command
        autoHighlight={false}
        highlightItemOnHover={false}
        itemToStringValue={(decision) => decision.caseNumber}
        items={commandDecisions}
        keepHighlight={false}
        mode="none"
        onItemHighlighted={(_, eventDetails) => {
          if (eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
            return;
          }
          decisionVirtualizer.scrollToIndex(eventDetails.index, {
            align: "auto",
          });
        }}
        onValueChange={(value, eventDetails) => {
          if (eventDetails.reason === "item-press") {
            return;
          }
          setQuery(value);
          debouncedSetSearch(value);
        }}
        value={query}
        virtualized
      >
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <CommandInput
            autoFocus
            className="text-sm"
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                (query.trim() || filters.search?.trim())
              ) {
                event.preventDefault();
                event.stopPropagation();
                clearSearchQuery();
              }
            }}
            placeholder={t("caseLaw.filters.searchPlaceholder")}
          />
          {isFetching && !isFetchingNextPage ? (
            <LoaderIcon className="text-muted-foreground size-4 shrink-0 animate-spin" />
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div className="border-b px-3 py-3 sm:hidden">
            <CaseLawFilters
              facets={facets}
              filters={filters}
              locale={locale}
              onDateChange={updateDateFilter}
              onFilterClick={handleFilterLinkClick}
            />
          </div>
          <aside className="hidden w-72 shrink-0 overflow-y-auto border-e px-3 py-3 sm:block">
            <CaseLawFilters
              facets={facets}
              filters={filters}
              locale={locale}
              onDateChange={updateDateFilter}
              onFilterClick={handleFilterLinkClick}
            />
          </aside>

          <CommandList
            className="bg-muted/30 max-h-none min-w-0 flex-1 overflow-y-auto"
            ref={resultsRef}
          >
            {!hasTypedQuery ? (
              <CaseLawRecents
                onSearchClick={handleRecentSearchClick}
                recentSearches={recentSearches}
              />
            ) : null}

            {shouldShowSkeletons ? <CaseLawLoadingSkeleton /> : null}

            {hasTypedQuery &&
            hasSearchQuery &&
            !shouldShowSkeletons &&
            decisions.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 py-8">
                <p className="text-muted-foreground text-sm">
                  {t("search.noResults", { query: filters.search ?? query })}
                </p>
              </div>
            ) : null}

            {shouldShowResults ? (
              <div className="px-3 py-3">
                <div
                  className="relative"
                  style={{
                    height: `${decisionVirtualizer.getTotalSize()}px`,
                  }}
                >
                  {virtualDecisions.map((virtualDecision) => {
                    const decision = decisions.at(virtualDecision.index);
                    if (!decision) {
                      return null;
                    }
                    return (
                      <div
                        className="absolute inset-x-0 top-0 pb-3"
                        data-index={virtualDecision.index}
                        key={decision.id}
                        ref={decisionVirtualizer.measureElement}
                        style={{
                          transform: `translateY(${virtualDecision.start}px)`,
                        }}
                      >
                        <DecisionResultItem
                          decision={decision}
                          index={virtualDecision.index}
                          resultNumber={virtualDecision.index + 1}
                          searchQuery={filters.search}
                          showHeadline={hasSearchQuery}
                        />
                      </div>
                    );
                  })}
                </div>
                {hasNextPage ? (
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
                ) : null}
              </div>
            ) : null}
          </CommandList>
        </div>
      </Command>
    </main>
  );
}

const updateFilterValue = (
  filters: DecisionListFilters,
  key: keyof DecisionListFilters,
  value: string | null,
): DecisionListFilters => {
  const next: DecisionListFilters = {};
  const filterKeys = [
    "country",
    "court",
    "dateFrom",
    "dateTo",
    "decisionType",
    "language",
    "sourceId",
    "search",
  ] as const;
  for (const filterKey of filterKeys) {
    if (filterKey !== key && filters[filterKey]) {
      next[filterKey] = filters[filterKey];
    }
  }
  const trimmed = value?.trim();
  if (trimmed) {
    next[key] = trimmed;
  }
  return next;
};

const caseLawFiltersFromSearch = (
  routeSearch: CaseLawRouteSearch,
): DecisionListFilters => {
  const filters: DecisionListFilters = {};
  if (routeSearch.q) {
    filters.search = routeSearch.q;
  }
  for (const key of CASE_LAW_FILTER_KEYS) {
    if (routeSearch[key]) {
      filters[key] = routeSearch[key];
    }
  }
  return filters;
};

const caseLawFiltersWithSearch = (
  filters: DecisionListFilters,
  search: string,
): DecisionListFilters => {
  const next = updateFilterValue(filters, "search", search);
  return next;
};

const setSearchDraftValue = (
  draft: CaseLawRouteSearch,
  key: CaseLawFilterKey | "search",
  value: string | null,
): void => {
  const trimmed = value?.trim();
  const nextValue = trimmed || undefined;

  if (key === "search") {
    draft.q = nextValue;
    return;
  }

  draft[key] = nextValue;
};

const recordRecentSearchIfNeeded = (
  filters: DecisionListFilters,
  scope: CaseLawRecentsScope,
): CaseLawRecentSearch[] => {
  const search = filters.search?.trim();
  return search
    ? recordCaseLawRecentSearch(search, filters, scope)
    : readCaseLawRecentSearches(scope);
};

type CaseLawFiltersProps = {
  facets: SearchFacets;
  filters: DecisionListFilters;
  locale: string;
  onFilterClick: (key: CaseLawFilterKey, value: string | null) => void;
  onDateChange: (key: CaseLawFilterKey, value: string | null) => void;
};

const CaseLawFilters = ({
  facets,
  filters,
  locale,
  onFilterClick,
  onDateChange,
}: CaseLawFiltersProps) => {
  const t = useTranslations();

  return (
    <div className="grid gap-4 sm:block sm:space-y-4">
      <FacetGroup
        buckets={mergeSelectedBucket(facets?.country ?? [], filters.country)}
        filterKey="country"
        onFilterClick={onFilterClick}
        selected={filters.country}
        title={t("caseLaw.filters.country")}
      />
      <FacetGroup
        buckets={mergeSelectedBucket(facets?.court ?? [], filters.court)}
        filterKey="court"
        onFilterClick={onFilterClick}
        selected={filters.court}
        title={t("caseLaw.filters.court")}
      />
      <FacetGroup
        buckets={mergeSelectedBucket(
          facets?.decisionType ?? [],
          filters.decisionType,
        )}
        filterKey="decisionType"
        onFilterClick={onFilterClick}
        selected={filters.decisionType}
        title={t("common.type")}
      />
      <FacetGroup
        buckets={mergeSelectedBucket(facets?.language ?? [], filters.language)}
        filterKey="language"
        onFilterClick={onFilterClick}
        selected={filters.language}
        title={t("common.language")}
      />
      <DateFilterRow
        label={t("search.dateFrom")}
        locale={locale}
        onChange={(value) => onDateChange("dateFrom", value)}
        value={filters.dateFrom ?? null}
      />
      <DateFilterRow
        label={t("search.dateTo")}
        locale={locale}
        onChange={(value) => onDateChange("dateTo", value)}
        value={filters.dateTo ?? null}
      />
    </div>
  );
};

type DateFilterRowProps = {
  label: string;
  locale: string;
  value: string | null;
  onChange: (value: string | null) => void;
};

const DateFilterRow = ({
  label,
  locale,
  value,
  onChange,
}: DateFilterRowProps) => (
  <div>
    <p className="text-muted-foreground mb-2 text-xs font-medium">{label}</p>
    <div className="[&_button]:px-2">
      <DatePickerPopover locale={locale} onChange={onChange} value={value} />
    </div>
  </div>
);

type FacetBucket = { value: string; count: number };

const mergeSelectedBucket = (
  buckets: FacetBucket[],
  selected: string | undefined,
): FacetBucket[] => {
  if (!selected || buckets.some((bucket) => bucket.value === selected)) {
    return buckets;
  }
  const next = [{ value: selected, count: 0 }];
  for (const bucket of buckets) {
    next.push(bucket);
  }
  return next;
};

type FacetGroupProps = {
  buckets: FacetBucket[];
  filterKey: CaseLawFilterKey;
  selected: string | undefined;
  title: string;
  onFilterClick: (key: CaseLawFilterKey, value: string | null) => void;
};

const FacetGroup = ({
  buckets,
  filterKey,
  selected,
  title,
  onFilterClick,
}: FacetGroupProps) => {
  if (buckets.length === 0 && !selected) {
    return null;
  }

  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs font-medium">{title}</p>
      <div className="space-y-0.5">
        {buckets.map((bucket) => {
          const isSelected = selected === bucket.value;
          const nextValue = isSelected ? null : bucket.value;
          return (
            <Link
              className="hover:bg-accent flex h-auto w-full items-center justify-start gap-2 rounded-md px-2 py-1 text-xs transition-colors"
              key={bucket.value}
              onClick={() => onFilterClick(filterKey, nextValue)}
              search={(prev) =>
                produce(prev, (draft) => {
                  setSearchDraftValue(draft, filterKey, nextValue);
                })
              }
              to="."
            >
              <Checkbox checked={isSelected} tabIndex={-1} />
              <span className="flex-1 truncate text-start">{bucket.value}</span>
              <span className="text-muted-foreground tabular-nums">
                {bucket.count}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
};

type DecisionResultItemProps = {
  decision: Decision;
  index: number;
  resultNumber: number;
  searchQuery: string | undefined;
  showHeadline: boolean;
};

const DecisionResultItem = ({
  decision,
  index,
  resultNumber,
  searchQuery,
  showHeadline,
}: DecisionResultItemProps) => {
  const t = useTranslations();
  const meta = useDecisionMeta(decision);
  const courtColor = getCourtColor(decision.court);

  return (
    <CaseLawSearchCard
      iconAlignment="start"
      icon={
        <LandmarkIcon
          className="size-4 shrink-0"
          style={{ color: courtColor }}
        />
      }
      index={index}
      render={
        <Link
          params={{
            decisionId: createCaseLawDecisionRouteParam({
              caseNumber: decision.caseNumber,
              decisionId: decision.id,
            }),
          }}
          search={searchQuery ? { q: searchQuery } : {}}
          to="/knowledge/case/$decisionId"
        />
      }
      right={
        <span className="text-muted-foreground/45 shrink-0 px-1 text-xs tabular-nums">
          {resultNumber}
        </span>
      }
      value={decision}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <p className="min-w-0 truncate text-sm font-medium">
          {decision.caseNumber} - {decision.court}
        </p>
        {decision.decisionType ? (
          <CaseLawBadge color={resolveDecisionTypeColor(decision.decisionType)}>
            {decision.decisionType}
          </CaseLawBadge>
        ) : null}
        <DecisionTreatmentBadge decision={decision} />
        {decision.authorityScore > 0 ? (
          <AuthorityBadge score={decision.authorityScore} />
        ) : null}
      </div>
      <p className="text-muted-foreground mt-0.5 truncate text-xs">
        {meta || t("common.caseLaw")}
      </p>
      {showHeadline && decision.headline ? (
        <p
          className="text-muted-foreground [&_mark]:bg-highlight [&_mark]:text-highlight-foreground mt-1 line-clamp-3 text-sm font-normal [&_mark]:font-medium"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: decision.headline }}
        />
      ) : null}
    </CaseLawSearchCard>
  );
};

const CaseLawBadge = ({
  children,
  color,
}: {
  children: ReactNode;
  color: string;
}) => (
  <span
    className="inline-flex max-w-36 shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-medium"
    style={{
      backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
      borderColor: `color-mix(in srgb, ${color} 35%, var(--color-border))`,
      color,
    }}
  >
    <span className="truncate">{children}</span>
  </span>
);

const DecisionTreatmentBadge = ({ decision }: { decision: Decision }) => {
  const t = useTranslations();
  const positiveCount =
    decision.positiveCitationCount + decision.supportiveCitationCount;

  if (decision.negativeCitationCount > 0) {
    return (
      <CaseLawBadge color="var(--option-red)">
        {t("caseLaw.treatment.badLaw")}
      </CaseLawBadge>
    );
  }

  if (positiveCount > 0) {
    return (
      <CaseLawBadge color="var(--option-emerald)">
        {t("caseLaw.treatment.goodLaw")}
      </CaseLawBadge>
    );
  }

  if (decision.citationCount > 0) {
    return (
      <CaseLawBadge color="var(--option-cyan)">
        {t("caseLaw.treatment.cited")}
      </CaseLawBadge>
    );
  }

  return null;
};

const authorityPercent = (score: number): number =>
  Math.min(100, Math.max(1, Math.round((1 - Math.exp(-score)) * 100)));

type AuthorityLevel = "weak" | "moderate" | "strong";

const authorityLevel = (percent: number): AuthorityLevel => {
  if (percent >= 70) {
    return "strong";
  }
  if (percent >= 35) {
    return "moderate";
  }
  return "weak";
};

const AUTHORITY_COLORS = {
  weak: "var(--option-red)",
  moderate: "var(--option-amber)",
  strong: "var(--option-emerald)",
} as const satisfies Record<AuthorityLevel, string>;

const AuthorityBadge = ({ score }: { score: number }) => {
  const t = useTranslations();
  const percent = authorityPercent(score);
  const level = authorityLevel(percent);

  return (
    <CaseLawBadge color={AUTHORITY_COLORS[level]}>
      {t("caseLaw.authorityScore", {
        label: t(`caseLaw.authority.${level}`),
        percent: String(percent),
      })}
    </CaseLawBadge>
  );
};

const DECISION_TYPE_COLORS = [
  "--option-blue",
  "--option-violet",
  "--option-cyan",
  "--option-teal",
] as const;

const resolveDecisionTypeColor = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash, 31) + (value.codePointAt(i) ?? 0);
  }
  return `var(${DECISION_TYPE_COLORS[Math.abs(hash) % DECISION_TYPE_COLORS.length]})`;
};

const useDecisionMeta = (decision: Decision): string => {
  const format = useFormatter();
  const t = useTranslations();
  const parts: string[] = [];
  const date = parseDecisionDate(decision.decisionDate);

  if (date) {
    parts.push(format.dateTime(date, { dateStyle: "medium" }));
  }
  if (decision.sourceName) {
    parts.push(decision.sourceName);
  }
  if (decision.citationCount > 0) {
    parts.push(t("caseLaw.citationCount", { count: decision.citationCount }));
  }

  return parts.join(" · ");
};

const parseDecisionDate = (value: Date | string | null): Date | null => {
  if (value === null || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

type CaseLawRecentsProps = {
  recentSearches: CaseLawRecentSearch[];
  onSearchClick: (recent: CaseLawRecentSearch) => void;
};

const CaseLawRecents = ({
  onSearchClick,
  recentSearches,
}: CaseLawRecentsProps) => {
  const t = useTranslations();
  const groups = groupCaseLawRecentSearchesByDate(recentSearches);

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-8">
        <p className="text-muted-foreground text-sm">
          {t("caseLaw.searchEmptyState")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-3 py-3">
      {groups.map((group) => (
        <section key={group.dateKey}>
          <h3 className="text-muted-foreground mb-2 text-sm font-medium">
            {group.dateKey}
          </h3>
          <div className="space-y-3">
            {group.searches.map((recent) => (
              <RecentSearchButton
                key={`${recent.query}-${recent.searchedAt}`}
                onClick={() => onSearchClick(recent)}
                recent={recent}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

type RecentSearchButtonProps = {
  recent: CaseLawRecentSearch;
  onClick: () => void;
};

const RecentSearchButton = ({ recent, onClick }: RecentSearchButtonProps) => (
  <CaseLawSearchCard
    icon={<HistoryIcon className="text-muted-foreground size-4 shrink-0" />}
    render={
      <Link
        onClick={onClick}
        search={(prev) =>
          produce(prev, (draft) => {
            setSearchDraftValue(draft, "search", recent.query);
            for (const key of CASE_LAW_FILTER_KEYS) {
              setSearchDraftValue(draft, key, recent.filters[key] ?? null);
            }
          })
        }
        to="."
      />
    }
  >
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <p className="min-w-0 truncate text-sm font-medium">{recent.query}</p>
      <RecentFilterSummary filters={recent.filters} />
    </div>
  </CaseLawSearchCard>
);

type CaseLawSearchCardProps = {
  children: ReactNode;
  icon: ReactNode;
  iconAlignment?: "center" | "start";
  index?: number;
  render?: ReactElement;
  right?: ReactNode;
  value?: Decision;
};

const CaseLawSearchCard = ({
  children,
  icon,
  iconAlignment = "center",
  index,
  render,
  right,
  value,
}: CaseLawSearchCardProps) => (
  <CommandItem
    className="bg-background hover:bg-muted/60 data-highlighted:bg-muted/60 data-highlighted:text-foreground h-auto w-full cursor-pointer items-center justify-start gap-3 rounded-md border px-3 py-3 text-start whitespace-normal shadow-xs transition-colors sm:h-auto"
    index={index}
    render={render}
    value={value}
  >
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        iconAlignment === "start" ? "mt-1 self-start" : "self-center",
      )}
    >
      {icon}
    </span>
    <div className="min-w-0 flex-1">{children}</div>
    {right !== undefined ? (
      <div className="ms-auto flex max-w-[50%] shrink-0 items-center justify-end">
        {right}
      </div>
    ) : null}
  </CommandItem>
);

const RecentFilterSummary = ({ filters }: { filters: DecisionListFilters }) => {
  const format = useFormatter();
  const t = useTranslations();
  const parts = [
    filters.country
      ? { label: t("caseLaw.filters.country"), value: filters.country }
      : null,
    filters.court
      ? { label: t("caseLaw.filters.court"), value: filters.court }
      : null,
    filters.decisionType
      ? { label: t("common.type"), value: filters.decisionType }
      : null,
    filters.language
      ? { label: t("common.language"), value: filters.language }
      : null,
    filters.dateFrom
      ? {
          label: t("search.dateFrom"),
          value: formatRecentDateFilter(filters.dateFrom, format),
        }
      : null,
    filters.dateTo
      ? {
          label: t("search.dateTo"),
          value: formatRecentDateFilter(filters.dateTo, format),
        }
      : null,
  ].filter((part) => part !== null);

  if (parts.length === 0) {
    return null;
  }

  return (
    <span className="flex flex-wrap gap-1">
      {parts.map((part) => (
        <span
          className="bg-muted text-muted-foreground inline-flex max-w-44 items-center rounded-sm px-1.5 py-0.5 text-xs"
          key={`${part.label}-${part.value}`}
        >
          <span className="shrink-0">{part.label}:&nbsp;</span>
          <span className="text-foreground truncate font-medium">
            {part.value}
          </span>
        </span>
      ))}
    </span>
  );
};

const formatRecentDateFilter = (
  value: string,
  format: ReturnType<typeof useFormatter>,
): string => {
  const date = parseDecisionDate(value);
  return date ? format.dateTime(date, { dateStyle: "medium" }) : value;
};

const CaseLawLoadingSkeleton = () => (
  <div className="space-y-3 px-3 py-3">
    {Array.from({ length: 5 }).map((_, i) => (
      <div
        className="bg-background flex min-h-20 items-center gap-3 rounded-md border px-3 py-3 shadow-xs"
        key={`case-law-skeleton-${i}`}
      >
        <Skeleton className="size-4 shrink-0 rounded-sm" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-4 w-64 max-w-[45%]" />
            <Skeleton className="h-5 w-16 rounded-md" />
            <Skeleton className="h-5 w-24 rounded-md" />
          </div>
          <Skeleton className="h-3 w-80 max-w-[55%]" />
          <Skeleton className="h-4 w-[min(44rem,80%)]" />
        </div>
        <Skeleton className="h-3 w-5 shrink-0" />
      </div>
    ))}
  </div>
);
