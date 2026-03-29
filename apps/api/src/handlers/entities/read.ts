import { panic } from "better-result";
import { and, count, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import type { ViewFilterCondition } from "@/api/handlers/registry/actors/views/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  buildFilterConditions,
  buildSortExpressions,
} from "@/api/lib/entity-filters";
import { LIMITS } from "@/api/lib/limits";

const viewFilterConditionSchema = t.Union([
  t.Object({
    id: t.String(),
    field: t.Literal("kind"),
    op: t.Literal("in"),
    value: t.Array(
      t.Union([
        t.Literal("document"),
        t.Literal("folder"),
        t.Literal("task"),
        t.Literal("message"),
        t.Literal("link"),
      ]),
    ),
  }),
  t.Object({
    id: t.String(),
    field: t.Literal("property"),
    propertyId: t.String({ minLength: 1 }),
    op: t.Union([
      t.Literal("eq"),
      t.Literal("neq"),
      t.Literal("contains"),
      t.Literal("is_empty"),
    ]),
    value: t.Optional(
      t.Union([t.String(), t.Array(t.String()), t.Undefined()]),
    ),
  }),
  t.Object({
    id: t.String(),
    field: t.Literal("builtin"),
    builtinField: t.Union([t.Literal("status"), t.Literal("priority")]),
    op: t.Union([
      t.Literal("eq"),
      t.Literal("neq"),
      t.Literal("in"),
      t.Literal("is_empty"),
    ]),
    value: t.Optional(
      t.Union([t.String(), t.Array(t.String()), t.Undefined()]),
    ),
  }),
]);

const viewSortSchema = t.Object({
  propertyId: t.String({ minLength: 1 }),
  desc: t.Boolean(),
});

export const readEntitiesBodySchema = t.Object({
  filters: t.Optional(t.Array(viewFilterConditionSchema)),
  sorts: t.Optional(t.Array(viewSortSchema)),
  page: t.Optional(t.Integer({ minimum: 1 })),
  pageSize: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesPageSizeMax,
    }),
  ),
});

type ViewSort = {
  propertyId: string;
  desc: boolean;
};

type ReadEntitiesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
  page: number;
  pageSize: number;
};

export const readEntitiesHandler = async ({
  scopedDb,
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
    scopedDb((tx) =>
      tx
        .select({ id: entities.id })
        .from(entities)
        .where(whereClause)
        .orderBy(...sortExpressions)
        .offset(offset)
        .limit(pageSize),
    ),
    scopedDb((tx) =>
      tx.select({ total: count() }).from(entities).where(whereClause),
    ),
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
    scopedDb((tx) =>
      tx
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
          status: entities.status,
          priority: entities.priority,
          dueDate: entities.dueDate,
          sortOrder: entities.sortOrder,
        })
        .from(entities)
        .leftJoin(user, eq(entities.createdBy, user.id))
        .where(idFilter),
    ),
    scopedDb((tx) =>
      tx
        .select({
          entityId: entityVersions.entityId,
          versionCount: count(),
        })
        .from(entityVersions)
        .where(inArray(entityVersions.entityId, pageIds))
        .groupBy(entityVersions.entityId),
    ),
    scopedDb((tx) =>
      tx
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
    status: string | null;
    priority: string | null;
    dueDate: string | null;
    sortOrder: string | null;
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
      status: entity.status,
      priority: entity.priority,
      dueDate: entity.dueDate,
      sortOrder: entity.sortOrder,
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

const config = {
  permissions: { workspace: ["read"] },
  body: readEntitiesBodySchema,
} satisfies HandlerConfig;

const readEntities = createHandler(
  config,
  async ({ scopedDb, workspaceId, body }) =>
    await readEntitiesHandler({
      scopedDb,
      workspaceId,
      filters: body.filters ?? [],
      sorts: body.sorts ?? [],
      page: body.page ?? 1,
      pageSize: body.pageSize ?? LIMITS.entitiesPageSizeDefault,
    }),
);

export default readEntities;
