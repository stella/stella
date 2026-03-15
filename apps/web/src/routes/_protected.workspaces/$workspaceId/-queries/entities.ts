import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
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
  page: ({ workspaceId, ...key }: EntitiesPageKey) => [
    ...entitiesKeys.all(workspaceId),
    key,
  ],
  summaries: (workspaceId: string) => [
    ...entitiesKeys.all(workspaceId),
    "summaries",
  ],
};

type EntitiesOptionsInput = {
  workspaceId: string;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
  page: number;
};

export const entitiesOptions = (input: EntitiesOptionsInput) =>
  queryOptions({
    queryKey: entitiesKeys.page(input),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: input.workspaceId })
        .get({
          query: {
            ...(input.filters.length > 0 && {
              filters: JSON.stringify(input.filters),
            }),
            ...(input.sorts.length > 0 && {
              sorts: JSON.stringify(input.sorts),
            }),
            page: input.page,
            pageSize: 50,
          },
          fetch: { signal },
        });

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
