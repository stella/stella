import { Result, panic } from "better-result";
import { and, count, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { SafeDb, Transaction } from "@/api/db";
import { member, user } from "@/api/db/auth-schema";
import {
  desktopEditSessions,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import {
  buildFilterConditions,
  buildSortExpressions,
} from "@/api/lib/entity-filters";
import type { ViewFilterCondition, ViewSort } from "@/api/lib/views-schema";

export type QueryEntitiesFieldMode = "full" | "visible";

export type QueryEntityResult = {
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
  activeEditBy: { name: string; image: string | null; isMe: boolean } | null;
  fields: {
    id: string;
    propertyId: string;
    entityId: string;
    content: FieldContent;
  }[];
};

type QueryEntitiesProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  currentUserId: string;
  currentOrganizationId: SafeId<"organization">;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
  offset: number;
  limit: number;
  fieldMode: QueryEntitiesFieldMode;
  fieldIds: SafeId<"property">[];
  excludedKinds?: EntityKind[];
  includeTotalCount: boolean;
};

const organizationMemberIdsSubquery = (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  aliasName: string,
) =>
  tx
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, organizationId))
    .groupBy(member.userId)
    .as(aliasName);

const queryEntitiesGenerator = async function* ({
  safeDb,
  workspaceId,
  currentUserId,
  currentOrganizationId,
  filters,
  sorts,
  offset,
  limit,
  fieldMode,
  fieldIds,
  excludedKinds = [],
  includeTotalCount,
}: QueryEntitiesProps) {
  const workspaceCondition = eq(entities.workspaceId, workspaceId);
  const filterConditions = buildFilterConditions(filters);
  const kindConditions =
    excludedKinds.length > 0 ? [notInArray(entities.kind, excludedKinds)] : [];
  const whereClause = and(
    workspaceCondition,
    ...filterConditions,
    ...kindConditions,
  );
  const sortExpressions = buildSortExpressions(sorts);

  const countRowsPromise = includeTotalCount
    ? safeDb((tx) =>
        tx.select({ total: count() }).from(entities).where(whereClause),
      )
    : Promise.resolve(null);

  const [idRowsResult, countRowsResult] = await Promise.all([
    safeDb((tx) =>
      tx
        .select({ id: entities.id })
        .from(entities)
        .where(whereClause)
        .orderBy(...sortExpressions)
        .offset(offset)
        .limit(limit),
    ),
    countRowsPromise,
  ]);

  const idRows = yield* idRowsResult;

  let totalCount: number | null = null;
  if (countRowsResult !== null) {
    const countResult = yield* countRowsResult;
    totalCount = countResult.at(0)?.total ?? 0;
  }

  const pageIds = idRows.map((r) => r.id);

  if (pageIds.length === 0) {
    return Result.ok({
      entities: [],
      totalCount,
    });
  }

  // Phase 2: Fetch entity metadata and the requested field payloads.
  const idFilter = inArray(entities.id, pageIds);

  const lastEditor = alias(user, "last_editor");
  const sessionEditor = alias(user, "session_editor");
  const fieldPredicates = [
    eq(fields.entityVersionId, entities.currentVersionId),
    idFilter,
  ];
  if (fieldMode === "visible") {
    const uniqueFieldIds = [...new Set(fieldIds)];
    const fileFieldCondition = sql`${fields.content}->>'type' = 'file'`;
    if (uniqueFieldIds.length === 0) {
      fieldPredicates.push(fileFieldCondition);
    } else {
      const visibleFieldCondition = or(
        fileFieldCondition,
        inArray(fields.propertyId, uniqueFieldIds),
      );
      if (visibleFieldCondition) {
        fieldPredicates.push(visibleFieldCondition);
      }
    }
  }

  const [
    entityRowsResult,
    versionCountsResult,
    fieldRowsResult,
    activeSessionsResult,
  ] = await Promise.all([
    safeDb((tx) => {
      const createdByMembers = organizationMemberIdsSubquery(
        tx,
        currentOrganizationId,
        "created_by_members",
      );
      const lastEditorMembers = organizationMemberIdsSubquery(
        tx,
        currentOrganizationId,
        "last_editor_members",
      );

      return tx
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
          lastEditedByName: lastEditor.name,
          lastEditedByImage: lastEditor.image,
          status: entities.status,
          priority: entities.priority,
          dueDate: entities.dueDate,
          sortOrder: entities.sortOrder,
        })
        .from(entities)
        .leftJoin(
          createdByMembers,
          eq(entities.createdBy, createdByMembers.userId),
        )
        .leftJoin(user, eq(createdByMembers.userId, user.id))
        .leftJoin(
          lastEditorMembers,
          eq(entities.lastEditedBy, lastEditorMembers.userId),
        )
        .leftJoin(lastEditor, eq(lastEditorMembers.userId, lastEditor.id))
        .where(idFilter);
    }),
    safeDb((tx) =>
      tx
        .select({
          entityId: entityVersions.entityId,
          versionCount: count(),
        })
        .from(entityVersions)
        .where(inArray(entityVersions.entityId, pageIds))
        .groupBy(entityVersions.entityId),
    ),
    safeDb((tx) =>
      tx
        .select({
          entityVersionId: fields.entityVersionId,
          id: fields.id,
          propertyId: fields.propertyId,
          content: fields.content,
        })
        .from(fields)
        .innerJoin(entities, and(...fieldPredicates)),
    ),
    safeDb((tx) => {
      const sessionEditorMembers = organizationMemberIdsSubquery(
        tx,
        currentOrganizationId,
        "session_editor_members",
      );

      return tx
        .select({
          entityId: desktopEditSessions.entityId,
          createdBy: desktopEditSessions.createdBy,
          editorName: sessionEditor.name,
          editorImage: sessionEditor.image,
        })
        .from(desktopEditSessions)
        .innerJoin(
          sessionEditorMembers,
          eq(desktopEditSessions.createdBy, sessionEditorMembers.userId),
        )
        .innerJoin(
          sessionEditor,
          eq(sessionEditorMembers.userId, sessionEditor.id),
        )
        .where(
          and(
            inArray(desktopEditSessions.entityId, pageIds),
            eq(desktopEditSessions.status, "open"),
          ),
        )
        .orderBy(desktopEditSessions.createdAt);
    }),
  ]);

  const entityRows = yield* entityRowsResult;
  const versionCounts = yield* versionCountsResult;
  const fieldRows = yield* fieldRowsResult;
  const activeSessions = yield* activeSessionsResult;

  const versionCountMap = new Map(
    versionCounts.map((v) => [v.entityId, v.versionCount]),
  );

  const activeEditMap = new Map<
    string,
    { name: string; image: string | null; isMe: boolean }
  >();
  for (const s of activeSessions) {
    if (!activeEditMap.has(s.entityId)) {
      activeEditMap.set(s.entityId, {
        name: s.editorName ?? "",
        image: s.editorImage,
        isMe: s.createdBy === currentUserId,
      });
    }
  }

  const fieldsByVersionId = new Map<string, typeof fieldRows>();
  for (const field of fieldRows) {
    const list = fieldsByVersionId.get(field.entityVersionId);
    if (list) {
      list.push(field);
    } else {
      fieldsByVersionId.set(field.entityVersionId, [field]);
    }
  }

  const entityMap = new Map(entityRows.map((e) => [e.id, e]));

  const result: QueryEntityResult[] = [];
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
      createdBy: entity.lastEditedByName ?? entity.createdByName ?? null,
      createdByImage: entity.lastEditedByImage ?? entity.createdByImage ?? null,
      version: versionCountMap.get(entity.id) ?? 0,
      updatedAt: entity.updatedAt?.toISOString() ?? null,
      status: entity.status,
      priority: entity.priority,
      dueDate: entity.dueDate,
      sortOrder: entity.sortOrder,
      activeEditBy: activeEditMap.get(entity.id) ?? null,
      fields: entityFields.map((field) => ({
        id: field.id,
        propertyId: field.propertyId,
        entityId: entity.id,
        content: field.content,
      })),
    });
  }

  return Result.ok({
    entities: result,
    totalCount,
  });
};

export const queryEntities = async (props: QueryEntitiesProps) =>
  await Result.gen(() => queryEntitiesGenerator(props));
