import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { DAY_IN_MS } from "@stll/time";

import { api } from "@/lib/api";
import type { EntityKind, GlobalSearchResultType } from "@/lib/api-contract";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";
import { normalizeSearchQuery } from "@/lib/search.logic";

export const TIME_PRESETS = ["day", "week", "month", "year"] as const;
export type TimePreset = (typeof TIME_PRESETS)[number];

const TIME_PRESET_DURATIONS_MS = {
  day: DAY_IN_MS,
  week: 7 * DAY_IN_MS,
  month: 30 * DAY_IN_MS,
  year: 365 * DAY_IN_MS,
} as const satisfies Record<TimePreset, number>;

/**
 * Compute the ISO timestamp `now() - preset duration`. Callers should
 * resolve this once per logical search (when filters or the query
 * change) and reuse it across pagination, so the cutoff stays stable
 * for the duration of a `useInfiniteQuery` session.
 */
export const presetUpdatedFrom = (preset: TimePreset): string =>
  new Date(Date.now() - TIME_PRESET_DURATIONS_MS[preset]).toISOString();

export type SearchableFacet = "editor" | "workspace" | "mimeType";

export type SearchParams = {
  /** UI-owned gate derived from the raw query and explicit user filters. */
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
  limit?: number | undefined;
};

type SearchEnablementParams = Pick<
  SearchParams,
  | "query"
  | "types"
  | "kinds"
  | "editedByUserIds"
  | "mimeTypes"
  | "updatedFrom"
  | "updatedTo"
> & { workspaceIds?: readonly string[] };

// Keep this aligned with `hasSearchQueryOrSelectiveFilter` in the API.
// A workspace is authorization/scope, not a selective enough filter to load
// every document in a matter when the dialog opens with an initial workspace.
export const hasSearchQueryOrSelectiveFilter = ({
  query,
  types,
  kinds,
  editedByUserIds,
  mimeTypes,
  updatedFrom,
  updatedTo,
}: SearchEnablementParams): boolean =>
  query.trim().length > 0 ||
  types.length > 0 ||
  kinds.length > 0 ||
  editedByUserIds.length > 0 ||
  mimeTypes.length > 0 ||
  updatedFrom !== undefined ||
  updatedTo !== undefined;

type SearchFacetParams = {
  organizationId: string;
  facet: SearchableFacet;
  search: string;
} & SearchParams;

type SearchOwner = Pick<SearchParams, "organizationId" | "userId">;

type RecentFilePreviewFieldParams = SearchOwner & {
  entityId: string;
  fileFieldId?: string | null | undefined;
  filePropertyId?: string | null | undefined;
  mimeType: string | null;
  workspaceId: string;
};

export type SearchAISummaryParams = {
  query: string;
  locale: string;
  originalQuery?: string | undefined;
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  editedByUserIds: string[];
  mimeTypes: string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  limit?: number | undefined;
};

// Query keys are reconstructed field-by-field (never spread) so extra
// properties on a caller-supplied params object cannot leak into the cache
// identity and trigger spurious refetches.
const searchKeys = {
  all: ["search"] as const,
  owner: (params: SearchOwner) =>
    [
      ...searchKeys.all,
      {
        organizationId: params.organizationId,
        userId: params.userId,
      },
    ] as const,
  query: (params: SearchParams) =>
    [
      ...searchKeys.owner(params),
      "query",
      {
        query: normalizeSearchQuery(params.query),
        workspaceIds: params.workspaceIds,
        types: params.types,
        kinds: params.kinds,
        editedByUserIds: params.editedByUserIds,
        mimeTypes: params.mimeTypes,
        updatedFrom: params.updatedFrom,
        updatedTo: params.updatedTo,
        limit: params.limit,
      },
    ] as const,
  preview: ({
    organizationId,
    userId,
    query,
    resultId,
    type,
    updatedAt,
  }: SearchPreviewParams) =>
    [
      ...searchKeys.owner({ organizationId, userId }),
      "preview",
      {
        query: normalizeSearchQuery(query),
        resultId,
        type,
        updatedAt,
      },
    ] as const,
  recentFilePreviewField: (params: RecentFilePreviewFieldParams) =>
    [
      ...searchKeys.owner(params),
      "recent-file-preview-field",
      {
        entityId: params.entityId,
        fileFieldId: params.fileFieldId,
        filePropertyId: params.filePropertyId,
        mimeType: params.mimeType,
        workspaceId: params.workspaceId,
      },
    ] as const,
  facet: (params: SearchFacetParams) =>
    [
      ...searchKeys.owner(params),
      "facet",
      {
        organizationId: params.organizationId,
        facet: params.facet,
        search: params.search,
        query: params.query,
        workspaceIds: params.workspaceIds,
        types: params.types,
        kinds: params.kinds,
        editedByUserIds: params.editedByUserIds,
        mimeTypes: params.mimeTypes,
        updatedFrom: params.updatedFrom,
        updatedTo: params.updatedTo,
        limit: params.limit,
      },
    ] as const,
};

const belongsToSearchOwner = (
  queryKey: readonly unknown[] | undefined,
  owner: SearchOwner,
): boolean =>
  queryKey?.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      "organizationId" in part &&
      part.organizationId === owner.organizationId &&
      "userId" in part &&
      part.userId === owner.userId,
  ) ?? false;

export const searchInfiniteOptions = (params: SearchParams) =>
  infiniteQueryOptions({
    queryKey: searchKeys.query(params),
    queryFn: async ({ signal, pageParam }) => {
      const query = normalizeSearchQuery(params.query);
      const response = await api.search.post(
        {
          query,
          workspaceIds: params.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          kinds: params.kinds,
          types: params.types,
          editedByUserIds: params.editedByUserIds,
          mimeTypes: params.mimeTypes,
          ...(params.updatedFrom ? { updatedFrom: params.updatedFrom } : {}),
          ...(params.updatedTo ? { updatedTo: params.updatedTo } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        { fetch: { signal } },
      );

      return unwrapEden(response);
    },
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: (previousData, previousQuery) =>
      belongsToSearchOwner(previousQuery?.queryKey, params)
        ? previousData
        : undefined,
    enabled: params.enabled,
  });

type SearchPreviewParams = {
  organizationId: string;
  userId: string;
  query: string;
  resultId: string;
  type: GlobalSearchResultType;
  updatedAt: string;
};

/**
 * How long a preview body (or the recent-file identity that authorizes one)
 * is reused before the server re-checks access. Long enough to absorb a
 * hover burst between hits within one dialog session; short enough that an
 * access revocation stops showing already-fetched preview content within
 * seconds, not minutes.
 */
export const SEARCH_PREVIEW_ACCESS_RECHECK_MS = 30_000;

export const searchPreviewOptions = ({
  organizationId,
  userId,
  query,
  resultId,
  type,
  updatedAt,
}: SearchPreviewParams) =>
  queryOptions({
    queryKey: searchKeys.preview({
      organizationId,
      userId,
      query,
      resultId,
      type,
      updatedAt,
    }),
    queryFn: async ({ signal }) => {
      const response = await api.search.preview.post(
        {
          query: normalizeSearchQuery(query),
          resultId,
          type,
        },
        { fetch: { signal } },
      );

      return unwrapEden(response);
    },
    // The key is content-addressed (query + resultId + updatedAt), so a
    // cached preview can never show stale content for a changed document —
    // a change rotates `updatedAt` into a new key. Caching only defers the
    // access re-check, bounded by the shared window below, so hovering back
    // to an already-previewed hit is a cache hit instead of a refetch.
    staleTime: SEARCH_PREVIEW_ACCESS_RECHECK_MS,
  });

type RecentFilePreviewCandidate = {
  content: { mimeType?: string | null | undefined; type: string };
  id: string;
  propertyId: string;
};

type ResolveRecentFilePreviewFieldIdOptions = Pick<
  RecentFilePreviewFieldParams,
  "fileFieldId" | "filePropertyId" | "mimeType"
> & {
  fields: readonly RecentFilePreviewCandidate[];
};

export const resolveRecentFilePreviewFieldId = ({
  fields,
  fileFieldId,
  filePropertyId,
  mimeType,
}: ResolveRecentFilePreviewFieldIdOptions): string | null => {
  const isFile = ({ content }: RecentFilePreviewCandidate) =>
    content.type === "file";
  const exactField = fileFieldId
    ? fields.find(
        (candidate) => candidate.id === fileFieldId && isFile(candidate),
      )
    : undefined;
  if (exactField) {
    return exactField.id;
  }
  const replacementField = filePropertyId
    ? fields.find(
        (candidate) =>
          candidate.propertyId === filePropertyId && isFile(candidate),
      )
    : undefined;
  if (replacementField) {
    return replacementField.id;
  }
  if (fileFieldId || filePropertyId) {
    return null;
  }
  return (
    fields.find(
      (candidate) =>
        isFile(candidate) &&
        (mimeType === null || candidate.content.mimeType === mimeType),
    )?.id ?? null
  );
};

/**
 * Reauthorizes a recent file against the entity's current version. Exact field
 * identity wins; a stable property id follows replacement revisions; the MIME
 * fallback remains only for legacy recent entries without either identifier.
 */
export const recentFilePreviewFieldOptions = (
  params: RecentFilePreviewFieldParams,
) =>
  queryOptions({
    queryKey: searchKeys.recentFilePreviewField(params),
    // This query IS the access re-check for a recent file, so it must re-run
    // for a fresh dialog session — but within one session it should not
    // refire on every hover between recents.
    staleTime: SEARCH_PREVIEW_ACCESS_RECHECK_MS,
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(params.workspaceId) })
        .entity({ entityId: toSafeId<"entity">(params.entityId) })
        .get({ fetch: { signal } });
      const entity = unwrapEden(response);
      return resolveRecentFilePreviewFieldId({
        fields: entity.fields,
        fileFieldId: params.fileFieldId,
        filePropertyId: params.filePropertyId,
        mimeType: params.mimeType,
      });
    },
  });

export const searchFacetOptions = (params: SearchFacetParams) =>
  queryOptions({
    queryKey: searchKeys.facet(params),
    queryFn: async ({ signal }) => {
      const response = await api.search.facets.post(
        {
          facet: params.facet,
          search: params.search,
          query: params.query,
          workspaceIds: params.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          types: params.types,
          kinds: params.kinds,
          editedByUserIds: params.editedByUserIds,
          mimeTypes: params.mimeTypes,
          ...(params.updatedFrom ? { updatedFrom: params.updatedFrom } : {}),
          ...(params.updatedTo ? { updatedTo: params.updatedTo } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        { fetch: { signal } },
      );

      return unwrapEden(response);
    },
    enabled: params.enabled,
    placeholderData: (previousData, previousQuery) =>
      belongsToSearchOwner(previousQuery?.queryKey, params)
        ? previousData
        : undefined,
  });
