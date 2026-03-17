import { useDeferredValue } from "react";

import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import type {
  ViewFilterCondition,
  WorkspaceEntity,
  WorkspaceField,
} from "@/lib/types";

type ViewSort = {
  propertyId: string;
  desc: boolean;
};

type EntitiesPageKey = {
  workspaceId: string;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
  page: number;
};

export const entitiesKeys = {
  all: (workspaceId: string) => ["entities", workspaceId],
  page: ({ workspaceId, filters, sorts, page }: EntitiesPageKey) => [
    ...entitiesKeys.all(workspaceId),
    { filters, sorts, page },
  ],
  summaries: (workspaceId: string) => [
    ...entitiesKeys.all(workspaceId),
    "summaries",
  ],
};

type EntitiesOptionsInput = QueryOptionsInput<EntitiesPageKey>;

export const entitiesOptions = (key: EntitiesOptionsInput) =>
  queryOptions({
    queryKey: entitiesKeys.page(key),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: key.workspaceId })
        .query.post(
          {
            filters: key.filters,
            sorts: key.sorts,
            page: key.page,
            pageSize: 50,
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const { entities: rawEntities, ...rest } = response.data;

      const entities: WorkspaceEntity[] = rawEntities.map(
        ({ fields: rawFields, ...entity }) => {
          const fields: Record<string, WorkspaceField> = {};
          for (const field of rawFields) {
            fields[field.propertyId] = {
              id: field.id,
              entityId: field.entityId,
              content: field.content,
            };
          }
          return { ...entity, fields };
        },
      );

      return { ...rest, entities };
    },
  });

// Defers the key so useSuspenseQuery keeps showing stale
// data instead of triggering the suspense boundary when
// filters, sorts, or page change.
export const useEntitiesOptions = (key: EntitiesOptionsInput) =>
  entitiesOptions(useDeferredValue(key));

export const entityOptions = (workspaceId: string, entityId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), entityId],
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const entitySummariesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: entitiesKeys.summaries(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .summaries.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.summaries;
    },
  });
