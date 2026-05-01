import * as v from "valibot";
import type { InferOutput } from "valibot";

import { getStorageKey } from "@/consts";
import type { DecisionListFilters } from "@/routes/_protected.knowledge/case/-queries/decisions";

const CASE_LAW_RECENT_SEARCHES_KEY = getStorageKey("case-law-recent-searches");
const MAX_CASE_LAW_RECENT_SEARCHES = 12;

export type CaseLawRecentsScope = {
  organizationId: string;
  userId: string;
};

export type CaseLawRecentSearch = {
  filters: DecisionListFilters;
  query: string;
  searchedAt: string;
};

export type GroupedCaseLawRecentSearches = {
  dateKey: string;
  searches: CaseLawRecentSearch[];
};

const getStorage = (): Storage | null =>
  typeof window === "undefined" ? null : window.localStorage;

const scopedKey = (scope: CaseLawRecentsScope): string =>
  `${CASE_LAW_RECENT_SEARCHES_KEY}:${scope.organizationId}:${scope.userId}`;

const decisionListFiltersSchema = v.strictObject({
  court: v.optional(v.string()),
  country: v.optional(v.string()),
  dateFrom: v.optional(v.string()),
  dateTo: v.optional(v.string()),
  decisionType: v.optional(v.string()),
  language: v.optional(v.string()),
  sourceId: v.optional(v.string()),
});

const caseLawRecentSearchSchema = v.strictObject({
  filters: decisionListFiltersSchema,
  query: v.string(),
  searchedAt: v.string(),
});

const caseLawRecentSearchesStoreSchema = v.strictObject({
  version: v.literal(1),
  searches: v.array(caseLawRecentSearchSchema),
});

type StoredDecisionListFilters = v.InferOutput<
  typeof decisionListFiltersSchema
>;

const readList = (
  scope: CaseLawRecentsScope,
  storage: Storage | null = getStorage(),
): CaseLawRecentSearch[] => {
  const raw = storage?.getItem(scopedKey(scope));

  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  const result = v.safeParse(caseLawRecentSearchesStoreSchema, parsed);

  return result.success
    ? result.output.searches.map((search) => ({
        filters: normalizeFilters(search.filters),
        query: search.query,
        searchedAt: search.searchedAt,
      }))
    : [];
};

const writeList = (
  scope: CaseLawRecentsScope,
  searches: CaseLawRecentSearch[],
  storage: Storage | null = getStorage(),
): void => {
  if (!storage) {
    return;
  }

  const data: InferOutput<typeof caseLawRecentSearchesStoreSchema> = {
    version: 1,
    searches,
  };

  storage.setItem(scopedKey(scope), JSON.stringify(data));
};

const normalizeFilters = (
  filters: DecisionListFilters | StoredDecisionListFilters,
): DecisionListFilters => {
  const normalized: DecisionListFilters = {};
  for (const key of [
    "country",
    "court",
    "dateFrom",
    "dateTo",
    "decisionType",
    "language",
    "sourceId",
  ] as const) {
    const value = filters[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return normalized;
};

export const readCaseLawRecentSearches = (
  scope: CaseLawRecentsScope,
  storage: Storage | null = getStorage(),
): CaseLawRecentSearch[] => readList(scope, storage);

export const recordCaseLawRecentSearch = (
  query: string,
  filters: DecisionListFilters,
  scope: CaseLawRecentsScope,
  storage: Storage | null = getStorage(),
): CaseLawRecentSearch[] => {
  const trimmed = query.trim();
  if (!trimmed) {
    return readCaseLawRecentSearches(scope, storage);
  }

  const normalizedFilters = normalizeFilters(filters);
  const next: CaseLawRecentSearch[] = [
    {
      filters: normalizedFilters,
      query: trimmed,
      searchedAt: new Date().toISOString(),
    },
  ];
  for (const item of readCaseLawRecentSearches(scope, storage)) {
    if (item.query !== trimmed && next.length < MAX_CASE_LAW_RECENT_SEARCHES) {
      next.push(item);
    }
  }

  writeList(scope, next, storage);
  return next;
};

export const groupCaseLawRecentSearchesByDate = (
  searches: readonly CaseLawRecentSearch[],
): GroupedCaseLawRecentSearches[] => {
  const groups = new Map<string, CaseLawRecentSearch[]>();

  for (const search of searches) {
    const date = new Date(search.searchedAt);
    const dateKey = Number.isNaN(date.getTime())
      ? search.searchedAt.slice(0, 10)
      : date.toLocaleDateString();
    const group = groups.get(dateKey) ?? [];
    group.push(search);
    groups.set(dateKey, group);
  }

  return groups
    .entries()
    .toArray()
    .map(([dateKey, groupSearches]) => ({
      dateKey,
      searches: groupSearches,
    }));
};
