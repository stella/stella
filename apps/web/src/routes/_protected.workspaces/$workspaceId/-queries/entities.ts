import { useDeferredValue } from "react";

import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
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
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
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

      const entities: WorkspaceEntity[] = rawEntities.map((entity) => {
        const { fields: rawFields } = entity;
        const fields: Record<string, WorkspaceField> = {};
        for (const field of rawFields) {
          fields[field.propertyId] = {
            id: toSafeId<"field">(field.id),
            entityId: toSafeId<"entity">(field.entityId),
            content: field.content,
          };
        }
        return {
          entityId: toSafeId<"entity">(entity.entityId),
          kind: entity.kind,
          name: entity.name,
          parentId:
            entity.parentId === null
              ? null
              : toSafeId<"entity">(entity.parentId),
          createdAt: entity.createdAt,
          createdBy: entity.createdBy,
          createdByImage: entity.createdByImage,
          updatedAt: entity.updatedAt,
          version: entity.version,
          status: entity.status,
          priority: entity.priority,
          dueDate: entity.dueDate,
          sortOrder: entity.sortOrder,
          activeEditBy: entity.activeEditBy,
          fields,
        };
      });

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
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
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
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .summaries.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.summaries;
    },
  });
