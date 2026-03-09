import { panic } from "better-result";
import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import type { ViewFilterCondition } from "@/api/handlers/registry/actors/views/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  buildFilterConditions,
  buildSortExpressions,
} from "@/api/lib/entity-filters";

type ViewSort = {
  propertyId: string;
  desc: boolean;
};

type ReadEntitiesHandlerProps = {
  workspaceId: SafeId<"workspace">;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
  page: number;
  pageSize: number;
};

export const readEntitiesHandler = async ({
  workspaceId,
  filters,
  sorts,
  page,
  pageSize,
}: ReadEntitiesHandlerProps) => {
  const offset = (page - 1) * pageSize;

  const workspaceCondition = eq(entities.workspaceId, workspaceId);
  const filterConditions = buildFilterConditions(filters);
  const whereClause = and(workspaceCondition, ...filterConditions);
  const sortExpressions = buildSortExpressions(sorts);

  // Phase 1: Get paginated IDs and total count in parallel
  const [idRows, countResult] = await Promise.all([
    db
      .select({ id: entities.id })
      .from(entities)
      .where(whereClause)
      .orderBy(...sortExpressions)
      .offset(offset)
      .limit(pageSize),
    db.select({ total: count() }).from(entities).where(whereClause),
  ]);

  const totalCount = countResult.at(0)?.total ?? 0;
  const pageIds = idRows.map((r) => r.id);

  if (pageIds.length === 0) {
    return {
      entities: [],
      totalCount,
      page,
      pageSize,
    };
  }

  // Phase 2: Fetch full entity data for the page
  const idFilter = inArray(entities.id, pageIds);

  const [entityRows, versionCounts, fieldRows] = await Promise.all([
    db
      .select({
        id: entities.id,
        kind: entities.kind,
        name: entities.name,
        parentId: entities.parentId,
        currentVersionId: entities.currentVersionId,
        createdAt: entities.createdAt,
        updatedAt: entities.updatedAt,
        createdByName: user.name,
        createdByImage: user.image,
      })
      .from(entities)
      .leftJoin(user, eq(entities.createdBy, user.id))
      .where(idFilter),
    db
      .select({
        entityId: entityVersions.entityId,
        versionCount: count(),
      })
      .from(entityVersions)
      .where(inArray(entityVersions.entityId, pageIds))
      .groupBy(entityVersions.entityId),
    db
      .select({
        entityVersionId: fields.entityVersionId,
        id: fields.id,
        propertyId: fields.propertyId,
        content: fields.content,
      })
      .from(fields)
      .innerJoin(
        entities,
        and(eq(fields.entityVersionId, entities.currentVersionId), idFilter),
      ),
  ]);

  // Index lookup maps
  const versionCountMap = new Map(
    versionCounts.map((v) => [v.entityId, v.versionCount]),
  );

  const fieldsByVersionId = new Map<string, typeof fieldRows>();
  for (const field of fieldRows) {
    const list = fieldsByVersionId.get(field.entityVersionId);
    if (list) {
      list.push(field);
    } else {
      fieldsByVersionId.set(field.entityVersionId, [field]);
    }
  }

  // Build entity map for reordering
  const entityMap = new Map(entityRows.map((e) => [e.id, e]));

  // Reorder to match Phase 1 sort order and build result
  type EntityResult = {
    entityId: string;
    kind: EntityKind;
    name: string | null;
    parentId: string | null;
    createdAt: string;
    createdBy: string | null;
    createdByImage: string | null;
    version: number;
    updatedAt: string | null;
    fields: {
      id: string;
      propertyId: string;
      entityId: string;
      content: FieldContent;
    }[];
  };
  const result: EntityResult[] = [];
  for (const id of pageIds) {
    const entity = entityMap.get(id);
    if (!entity) {
      continue;
    }

    const versionId = entity.currentVersionId;
    if (!versionId) {
      panic("Entity has no currentVersion");
    }

    const entityFields = fieldsByVersionId.get(versionId) ?? [];

    result.push({
      entityId: entity.id,
      kind: entity.kind,
      name: entity.name,
      parentId: entity.parentId,
      createdAt: entity.createdAt.toISOString(),
      createdBy: entity.createdByName ?? null,
      createdByImage: entity.createdByImage ?? null,
      version: versionCountMap.get(entity.id) ?? 0,
      updatedAt: entity.updatedAt?.toISOString() ?? null,
      fields: entityFields.map((field) => ({
        id: field.id,
        propertyId: field.propertyId,
        entityId: entity.id,
        content: field.content,
      })),
    });
  }

  return {
    entities: result,
    totalCount,
    page,
    pageSize,
  };
};
