import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

export const legalListKeys = {
  all: (workspaceId: string) => ["legal-lists", workspaceId] as const,
  detail: (workspaceId: string, listId: string) => [
    ...legalListKeys.all(workspaceId),
    listId,
  ],
  items: (workspaceId: string, listId: string) => [
    ...legalListKeys.detail(workspaceId, listId),
    "items",
  ],
  generations: (workspaceId: string, listId: string) => [
    ...legalListKeys.detail(workspaceId, listId),
    "generations",
  ],
  candidates: (workspaceId: string, listId: string, runId: string) => [
    ...legalListKeys.generations(workspaceId, listId),
    runId,
    "candidates",
  ],
  sources: (workspaceId: string, listId: string, itemEntityId: string) => [
    ...legalListKeys.items(workspaceId, listId),
    itemEntityId,
    "sources",
  ],
  activity: (workspaceId: string, listId: string, itemEntityId: string) => [
    ...legalListKeys.items(workspaceId, listId),
    itemEntityId,
    "activity",
  ],
};

export const legalListsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: legalListKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .get({ query: { limit: 100, status: "active" }, fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const legalListOptions = (workspaceId: string, listId: string) =>
  queryOptions({
    queryKey: legalListKeys.detail(workspaceId, listId),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          listId: toSafeId<"legalList">(listId),
        })
        .get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    enabled: listId.length > 0,
  });

export const legalListItemsOptions = (workspaceId: string, listId: string) =>
  infiniteQueryOptions({
    queryKey: legalListKeys.items(workspaceId, listId),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          listId: toSafeId<"legalList">(listId),
        })
        .items.get({
          query: {
            limit: 200,
            ...(pageParam && { cursor: pageParam }),
          },
          fetch: { signal },
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: listId.length > 0,
  });

export const legalListGenerationsOptions = (
  workspaceId: string,
  listId: string,
) =>
  queryOptions({
    queryKey: legalListKeys.generations(workspaceId, listId),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          listId: toSafeId<"legalList">(listId),
        })
        .generations.get({ query: { limit: 20 }, fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    enabled: listId.length > 0,
  });

export const legalListCandidatesOptions = (
  workspaceId: string,
  listId: string,
  runId: string,
) =>
  queryOptions({
    queryKey: legalListKeys.candidates(workspaceId, listId, runId),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          listId: toSafeId<"legalList">(listId),
        })
        .generations({
          runId: toSafeId<"legalListGenerationRun">(runId),
        })
        .candidates.get({ query: { limit: 200 }, fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    enabled: listId.length > 0 && runId.length > 0,
  });

export const legalListSourcesOptions = (
  workspaceId: string,
  listId: string,
  itemEntityId: string,
) =>
  queryOptions({
    queryKey: legalListKeys.sources(workspaceId, listId, itemEntityId),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          listId: toSafeId<"legalList">(listId),
        })
        .items({ itemEntityId: toSafeId<"entity">(itemEntityId) })
        .sources.get({ query: { limit: 200 }, fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    enabled: itemEntityId.length > 0,
  });

export const legalListActivityOptions = (
  workspaceId: string,
  listId: string,
  itemEntityId: string,
) =>
  queryOptions({
    queryKey: legalListKeys.activity(workspaceId, listId, itemEntityId),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          listId: toSafeId<"legalList">(listId),
        })
        .items({ itemEntityId: toSafeId<"entity">(itemEntityId) })
        .activity.get({ query: { limit: 50 }, fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    enabled: itemEntityId.length > 0,
  });
