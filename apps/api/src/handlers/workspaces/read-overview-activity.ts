import { Result } from "better-result";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { t } from "elysia";

// eslint-disable-next-line security-guards/no-unscoped-user-query -- actor IDs come only from audit rows already scoped to this authorized organization and workspace; a membership join would erase retained attribution after account deletion.
import { user } from "@/api/db/auth-schema";
import { auditLogs, entities, entityVersions, fields } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import {
  brandPersistedAuditLogId,
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
} from "@/api/lib/safe-id-boundaries";

import {
  parseFieldAuditResourceId,
  resolveActivityCategory,
} from "./read-overview-activity.logic";

const ACTIVITY_FILTERS = [
  "all",
  "documents",
  "tasks",
  "matter",
  "team",
  "court",
  "automation",
] as const;

const versionSnapshotAuditLogs = alias(
  auditLogs,
  "version_snapshot_audit_logs",
);
const entitySnapshotAuditLogs = alias(auditLogs, "entity_snapshot_audit_logs");

const VISIBLE_ACTIONS = [
  AUDIT_ACTION.CREATE,
  AUDIT_ACTION.UPDATE,
  AUDIT_ACTION.DELETE,
  AUDIT_ACTION.EXECUTE,
  AUDIT_ACTION.CANCEL,
  AUDIT_ACTION.REVIEW,
] as const;

const LEGACY_VISIBLE_RESOURCE_TYPES = [
  AUDIT_RESOURCE_TYPE.ENTITY,
  AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
  AUDIT_RESOURCE_TYPE.FIELD,
  AUDIT_RESOURCE_TYPE.USER_FILE,
  AUDIT_RESOURCE_TYPE.WORKSPACE,
  AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER,
  AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT,
  AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK,
  AUDIT_RESOURCE_TYPE.FLOW_RUN,
] as const;

type ActivityCategory = Exclude<(typeof ACTIVITY_FILTERS)[number], "all">;

const legacyEntityKind = () =>
  sql<string>`coalesce(
    ${auditLogs.metadata} ->> 'kind',
    ${auditLogs.changes} -> 'created' -> 'new' ->> 'kind',
    ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'kind'
  )`;

const legacyEntityVersionIdText = () => sql<string>`coalesce(
  nullif(${auditLogs.metadata} ->> 'entityVersionId', ''),
  case
    when ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY_VERSION}
      then ${auditLogs.resourceId}
    when ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.FIELD}
      then split_part(${auditLogs.resourceId}, ':', 1)
  end
)`;

const auditEntityIdSnapshot = () => sql<string | null>`coalesce(
  ${auditLogs.metadata} ->> 'entityId',
  ${auditLogs.changes} -> 'created' -> 'new' ->> 'entityId',
  ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'entityId',
  case
    when ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
      then ${auditLogs.resourceId}
  end
)`;

const siblingVersionEntityIdSnapshot = () => sql<string | null>`(
  select coalesce(
    ${versionSnapshotAuditLogs.metadata} ->> 'entityId',
    ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'entityId',
    ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'entityId'
  )
  from ${versionSnapshotAuditLogs}
  where ${versionSnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
    and ${versionSnapshotAuditLogs.workspaceId} = ${auditLogs.workspaceId}
    and ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY_VERSION}
    and ${versionSnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY_VERSION}
    and ${versionSnapshotAuditLogs.resourceId} = ${auditLogs.resourceId}
    and coalesce(
      ${versionSnapshotAuditLogs.metadata} ->> 'entityId',
      ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'entityId',
      ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'entityId'
    ) is not null
  order by ${versionSnapshotAuditLogs.createdAt}, ${versionSnapshotAuditLogs.id}
  limit 1
)`;

const auditEntityNameSnapshot = () => sql<string | null>`coalesce(
  ${auditLogs.metadata} ->> 'entityName',
  ${auditLogs.metadata} ->> 'fileName',
  ${auditLogs.changes} -> 'created' -> 'new' ->> 'name',
  ${auditLogs.changes} -> 'created' -> 'new' ->> 'fileName',
  ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
)`;

const siblingVersionEntityNameSnapshot = () => sql<string | null>`(
  select coalesce(
    ${versionSnapshotAuditLogs.metadata} ->> 'entityName',
    ${versionSnapshotAuditLogs.metadata} ->> 'fileName',
    ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'name',
    ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'fileName',
    ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
  )
  from ${versionSnapshotAuditLogs}
  where ${versionSnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
    and ${versionSnapshotAuditLogs.workspaceId} = ${auditLogs.workspaceId}
    and ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY_VERSION}
    and ${versionSnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY_VERSION}
    and ${versionSnapshotAuditLogs.resourceId} = ${auditLogs.resourceId}
    and coalesce(
      ${versionSnapshotAuditLogs.metadata} ->> 'entityName',
      ${versionSnapshotAuditLogs.metadata} ->> 'fileName',
      ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'name',
      ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'fileName',
      ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
    ) is not null
  order by ${versionSnapshotAuditLogs.createdAt}, ${versionSnapshotAuditLogs.id}
  limit 1
)`;

const siblingDeletedEntityKind = () => sql<string | null>`(
  select ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'kind'
  from ${entitySnapshotAuditLogs}
  where ${entitySnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
    and ${entitySnapshotAuditLogs.workspaceId} = ${auditLogs.workspaceId}
    and ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entitySnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entitySnapshotAuditLogs.resourceId} = ${auditLogs.resourceId}
    and ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'kind' is not null
  order by ${entitySnapshotAuditLogs.createdAt} desc, ${entitySnapshotAuditLogs.id} desc
  limit 1
)`;

const siblingDeletedEntityName = () => sql<string | null>`(
  select ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
  from ${entitySnapshotAuditLogs}
  where ${entitySnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
    and ${entitySnapshotAuditLogs.workspaceId} = ${auditLogs.workspaceId}
    and ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entitySnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entitySnapshotAuditLogs.resourceId} = ${auditLogs.resourceId}
    and ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name' is not null
  order by ${entitySnapshotAuditLogs.createdAt} desc, ${entitySnapshotAuditLogs.id} desc
  limit 1
)`;

const legacyRelatedEntityKind = () => sql<string | null>`(
  select ${entities.kind}
  from ${entityVersions}
  inner join ${entities}
    on ${entities.id} = ${entityVersions.entityId}
    and ${entities.workspaceId} = ${auditLogs.workspaceId}
  where ${entityVersions.workspaceId} = ${auditLogs.workspaceId}
    and ${entityVersions.id} = case
      when ${legacyEntityVersionIdText()} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then ${legacyEntityVersionIdText()}::uuid
      else null
    end
  limit 1
)`;

const legacyDirectEntityKind = () => sql<string | null>`(
  select ${entities.kind}
  from ${entities}
  where ${entities.workspaceId} = ${auditLogs.workspaceId}
    and ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entities.id} = case
      when ${auditLogs.resourceId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then ${auditLogs.resourceId}::uuid
      else null
    end
  limit 1
)`;

const legacyResourceKind = () =>
  sql<string>`coalesce(
    ${legacyEntityKind()},
    ${legacyDirectEntityKind()},
    ${siblingDeletedEntityKind()},
    ${legacyRelatedEntityKind()}
  )`;

const taskEntityResourceCondition = () =>
  and(
    inArray(auditLogs.resourceType, [
      AUDIT_RESOURCE_TYPE.ENTITY,
      AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
      AUDIT_RESOURCE_TYPE.FIELD,
    ]),
    sql`${legacyResourceKind()} = 'task'`,
  ) ?? sql`false`;

const legacyWorkspaceTeamEvent = () =>
  sql<boolean>`(
    ${auditLogs.changes} ? 'membersAdded'
    OR ${auditLogs.changes} ? 'membersRemoved'
  )`;

const legacyCategoryCondition = (category: ActivityCategory): SQL => {
  switch (category) {
    case "documents":
      return (
        or(
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.USER_FILE),
          and(
            inArray(auditLogs.resourceType, [
              AUDIT_RESOURCE_TYPE.ENTITY,
              AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
              AUDIT_RESOURCE_TYPE.FIELD,
            ]),
            sql`coalesce(${legacyResourceKind()}, '') <> 'task'`,
          ),
        ) ?? sql`false`
      );
    case "tasks":
      return (
        and(
          inArray(auditLogs.resourceType, [
            AUDIT_RESOURCE_TYPE.ENTITY,
            AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
            AUDIT_RESOURCE_TYPE.FIELD,
          ]),
          sql`${legacyResourceKind()} = 'task'`,
        ) ?? sql`false`
      );
    case "matter":
      return (
        and(
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.WORKSPACE),
          sql`NOT ${legacyWorkspaceTeamEvent()}`,
        ) ?? sql`false`
      );
    case "team":
      return (
        or(
          inArray(auditLogs.resourceType, [
            AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER,
            AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT,
          ]),
          and(
            eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.WORKSPACE),
            legacyWorkspaceTeamEvent(),
          ),
        ) ?? sql`false`
      );
    case "court":
      return eq(
        auditLogs.resourceType,
        AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK,
      );
    case "automation":
      return eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.FLOW_RUN);
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
};

const activityCursor = createTimestampIdCursorCodec({
  column: auditLogs.createdAt,
  brandId: brandPersistedAuditLogId,
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: t.Object({
    category: t.Optional(
      t.Union([
        t.Literal("all"),
        t.Literal("documents"),
        t.Literal("tasks"),
        t.Literal("matter"),
        t.Literal("team"),
        t.Literal("court"),
        t.Literal("automation"),
      ]),
    ),
    cursor: t.Optional(t.String({ maxLength: 512 })),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.matterActivityPageSizeMax,
      }),
    ),
  }),
} satisfies HandlerConfig;

type ActivityTarget = {
  deleted: boolean;
  encrypted: boolean | null;
  entityId: string | null;
  fieldId: string | null;
  id: string;
  kind: "document" | "task" | "matter" | "team" | "court" | "automation";
  mimeType: string | null;
  name: string | null;
  pdfFileId: string | null;
  propertyId: string | null;
};

type EntityTarget = Omit<ActivityTarget, "kind"> & {
  kind: "document" | "task";
};

const readOverviewActivity = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, workspaceId }) {
    const cursor = query.cursor ? activityCursor.decode(query.cursor) : null;
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const limit = query.limit ?? LIMITS.matterActivityPageSizeDefault;
    const conditions = [
      eq(auditLogs.organizationId, session.activeOrganizationId),
      eq(auditLogs.workspaceId, workspaceId),
      inArray(auditLogs.action, VISIBLE_ACTIONS),
      or(
        and(
          isNotNull(auditLogs.activityCategory),
          ne(auditLogs.activityCategory, "other"),
        ),
        and(
          isNull(auditLogs.activityCategory),
          inArray(auditLogs.resourceType, LEGACY_VISIBLE_RESOURCE_TYPES),
        ),
      ),
    ];

    if (query.category === "automation") {
      conditions.push(
        or(
          eq(auditLogs.activityCategory, "automation"),
          ne(auditLogs.performerType, "user"),
          and(
            isNull(auditLogs.activityCategory),
            legacyCategoryCondition("automation"),
          ),
        ),
      );
    } else if (query.category && query.category !== "all") {
      const legacyCondition = legacyCategoryCondition(query.category);
      const storedOrLegacyCategory = or(
        eq(auditLogs.activityCategory, query.category),
        and(isNull(auditLogs.activityCategory), legacyCondition),
      );
      if (query.category === "tasks") {
        conditions.push(
          or(storedOrLegacyCategory, taskEntityResourceCondition()),
        );
      } else if (query.category === "documents") {
        conditions.push(
          and(
            storedOrLegacyCategory,
            sql`NOT coalesce(${taskEntityResourceCondition()}, false)`,
          ),
        );
      } else {
        conditions.push(storedOrLegacyCategory);
      }
    }
    if (cursor) {
      const cursorCondition = activityCursor.keysetAfter({
        cursor,
        idColumn: auditLogs.id,
        direction: "descending",
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            action: auditLogs.action,
            activityCategory: auditLogs.activityCategory,
            approvalStatus: auditLogs.approvalStatus,
            approvedByUserId: auditLogs.approvedByUserId,
            createdAt: auditLogs.createdAt,
            createdAtCursor: activityCursor.cursorValue.as("created_at_cursor"),
            entityIdSnapshot: sql<string | null>`coalesce(
              ${auditEntityIdSnapshot()},
              ${siblingVersionEntityIdSnapshot()}
            )`,
            entityNameSnapshot: sql<string | null>`coalesce(
              ${auditEntityNameSnapshot()},
              ${siblingDeletedEntityName()},
              ${siblingVersionEntityNameSnapshot()}
            )`,
            id: auditLogs.id,
            legacyKind: legacyResourceKind(),
            legacyWorkspaceTeamEvent: legacyWorkspaceTeamEvent(),
            performerId: auditLogs.performerId,
            performerName: auditLogs.performerName,
            performerType: auditLogs.performerType,
            resourceId: auditLogs.resourceId,
            resourceType: auditLogs.resourceType,
            runId: auditLogs.runId,
            triggerSource: auditLogs.triggerSource,
            triggerType: auditLogs.triggerType,
            triggerUserId: auditLogs.triggerUserId,
            userId: auditLogs.userId,
          })
          .from(auditLogs)
          .where(and(...conditions))
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(limit + 1);

        const directEntityIds = rows
          .filter((row) => row.resourceType === AUDIT_RESOURCE_TYPE.ENTITY)
          .map((row) => brandPersistedEntityId(row.resourceId));
        const directVersionIds = rows
          .filter(
            (row) => row.resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
          )
          .map((row) => brandPersistedEntityVersionId(row.resourceId));
        const fieldResources = rows
          .filter((row) => row.resourceType === AUDIT_RESOURCE_TYPE.FIELD)
          .map((row) => ({
            resourceId: row.resourceId,
            parsed: parseFieldAuditResourceId(row.resourceId),
          }));
        const fieldIds = fieldResources.flatMap(({ parsed }) =>
          parsed?.type === "field" ? [parsed.fieldId] : [],
        );
        const compositeFieldVersions = fieldResources.flatMap(
          ({ parsed, resourceId }) =>
            parsed?.type === "cell"
              ? [[resourceId, parsed.entityVersionId] as const]
              : [],
        );
        const fieldRows =
          fieldIds.length === 0
            ? []
            : await tx
                .select({
                  entityVersionId: fields.entityVersionId,
                  id: fields.id,
                })
                .from(fields)
                .where(
                  and(
                    eq(fields.workspaceId, workspaceId),
                    inArray(fields.id, fieldIds),
                  ),
                );
        const versionIds = [
          ...new Set([
            ...directVersionIds,
            ...fieldRows.map((row) => row.entityVersionId),
            ...compositeFieldVersions.map(([, versionId]) => versionId),
          ]),
        ];
        const versionRows =
          versionIds.length === 0
            ? []
            : await tx
                .select({
                  id: entityVersions.id,
                  entityId: entityVersions.entityId,
                })
                .from(entityVersions)
                .where(
                  and(
                    eq(entityVersions.workspaceId, workspaceId),
                    inArray(entityVersions.id, versionIds),
                  ),
                );
        const entityIds = [
          ...new Set([
            ...directEntityIds,
            ...versionRows.map((row) => row.entityId),
            ...rows.flatMap((row) =>
              row.entityIdSnapshot
                ? [brandPersistedEntityId(row.entityIdSnapshot)]
                : [],
            ),
          ]),
        ];
        const entityFile = sql<EntityFile | null>`(
          select jsonb_build_object(
            'id', ${fields.id},
            'propertyId', ${fields.propertyId},
            'fileName', ${fields.content}->>'fileName',
            'mimeType', ${fields.content}->>'mimeType',
            'pdfFileId', ${fields.content}->>'pdfFileId',
            'encrypted', ${fields.content}->'encrypted'
          )
          from ${fields}
          where ${fields.workspaceId} = ${entities.workspaceId}
            and ${fields.entityVersionId} = ${entities.currentVersionId}
            and ${fields.content}->>'type' = 'file'
          order by ${fields.propertyId}
          limit 1
        )`;
        const entityRows =
          entityIds.length === 0
            ? []
            : await tx
                .select({
                  file: entityFile,
                  id: entities.id,
                  kind: entities.kind,
                  name: entities.name,
                })
                .from(entities)
                .where(
                  and(
                    eq(entities.workspaceId, workspaceId),
                    inArray(entities.id, entityIds),
                  ),
                )
                .limit(limit + 1);
        const workspace = await tx.query.workspaces.findFirst({
          where: {
            id: { eq: workspaceId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { name: true },
        });

        const actorIds = [
          ...new Set(
            rows
              .flatMap((row) => [
                row.performerType === "user"
                  ? (row.performerId ?? row.userId)
                  : null,
                row.triggerUserId,
                row.approvedByUserId,
              ])
              .filter((id): id is string => id !== null),
          ),
        ];
        const actors =
          actorIds.length === 0
            ? []
            : await tx
                .select({
                  deletedAt: user.deletedAt,
                  email: user.email,
                  id: user.id,
                  image: user.image,
                  name: user.name,
                })
                .from(user)
                .where(inArray(user.id, actorIds));

        return {
          actors,
          compositeFieldVersions,
          entityRows,
          fieldRows,
          rows,
          versionRows,
          workspace,
        };
      }),
    );

    const actorMap = new Map(
      result.actors.map((actor) => [
        actor.id,
        {
          deletedAt: actor.deletedAt?.toISOString() ?? null,
          image: actor.image,
          name: actor.name || actor.email,
          type: "user" as const,
        },
      ]),
    );
    const entityMap = new Map(
      result.entityRows.map((entity) => [entity.id, toEntityTarget(entity)]),
    );
    const versionEntityMap = new Map(
      result.versionRows.map((version) => [version.id, version.entityId]),
    );
    const fieldVersionMap = new Map([
      ...result.fieldRows.map(
        (field) => [field.id, field.entityVersionId] as const,
      ),
      ...result.compositeFieldVersions,
    ]);
    const page = createCursorPage({
      rows: result.rows,
      limit,
      cursorForItem: (item) =>
        activityCursor.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      items: page.items.map((row) => {
        const performerId = row.performerId ?? row.userId;
        const category = resolveActivityCategory({
          kind: row.legacyKind,
          persistedCategory: row.activityCategory,
          resourceType: row.resourceType,
          workspaceTeamEvent: row.legacyWorkspaceTeamEvent,
        });
        const performer =
          row.performerType === "user"
            ? (actorMap.get(performerId) ?? {
                deletedAt: null,
                image: null,
                name: null,
                type: "user" as const,
              })
            : {
                name: row.performerName,
                type: row.performerType,
              };

        return {
          action: row.action,
          activityAt: row.createdAt.toISOString(),
          approval: {
            status: row.approvalStatus,
            user: row.approvedByUserId
              ? (actorMap.get(row.approvedByUserId) ?? null)
              : null,
          },
          category,
          id: row.id,
          performer,
          runId: row.runId,
          target: targetForRow({
            category,
            entityMap,
            entityIdSnapshot: row.entityIdSnapshot,
            entityNameSnapshot: row.entityNameSnapshot,
            fieldVersionMap,
            matterName: result.workspace?.name ?? null,
            resourceId: row.resourceId,
            resourceType: row.resourceType,
            versionEntityMap,
          }),
          trigger: {
            source: row.triggerSource,
            type: row.triggerType,
            user: row.triggerUserId
              ? (actorMap.get(row.triggerUserId) ?? null)
              : null,
          },
        };
      }),
      limit: page.limit,
      nextCursor: page.nextCursor,
    });
  },
);

type EntityRow = {
  file: EntityFile | null;
  id: string;
  kind: (typeof entities.$inferSelect)["kind"];
  name: string;
};

type EntityFile = {
  encrypted: boolean;
  fileName: string;
  id: string;
  mimeType: string;
  pdfFileId: string | null;
  propertyId: string;
};

const toEntityTarget = (entity: EntityRow): EntityTarget => {
  return {
    deleted: false,
    encrypted: entity.file?.encrypted ?? null,
    entityId: entity.id,
    fieldId: entity.file?.id ?? null,
    id: entity.id,
    kind: entity.kind === "task" ? "task" : "document",
    mimeType: entity.file?.mimeType ?? null,
    name: entity.file?.fileName ?? entity.name,
    pdfFileId: entity.file?.pdfFileId ?? null,
    propertyId: entity.file?.propertyId ?? null,
  };
};

type TargetForRowOptions = {
  category: ActivityCategory;
  entityMap: Map<string, EntityTarget>;
  entityIdSnapshot: string | null;
  entityNameSnapshot: string | null;
  fieldVersionMap: Map<string, string>;
  matterName: string | null;
  resourceId: string;
  resourceType: string;
  versionEntityMap: Map<string, string>;
};

const targetForRow = ({
  category,
  entityMap,
  entityIdSnapshot,
  entityNameSnapshot,
  fieldVersionMap,
  matterName,
  resourceId,
  resourceType,
  versionEntityMap,
}: TargetForRowOptions): ActivityTarget => {
  if (resourceType === AUDIT_RESOURCE_TYPE.ENTITY) {
    return (
      entityMap.get(resourceId) ??
      deletedEntityTarget({
        category,
        id: resourceId,
        name: entityNameSnapshot,
      })
    );
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION) {
    const entityId = versionEntityMap.get(resourceId) ?? entityIdSnapshot;
    if (entityId) {
      return (
        entityMap.get(entityId) ??
        deletedEntityTarget({
          category,
          id: entityId,
          name: entityNameSnapshot,
        })
      );
    }
    return deletedEntityTarget({ category, id: resourceId, name: null });
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.FIELD) {
    const versionId = fieldVersionMap.get(resourceId);
    const entityId =
      (versionId ? versionEntityMap.get(versionId) : null) ?? entityIdSnapshot;
    if (entityId) {
      return (
        entityMap.get(entityId) ??
        deletedEntityTarget({
          category,
          id: entityId,
          name: entityNameSnapshot,
        })
      );
    }
    return deletedEntityTarget({ category, id: resourceId, name: null });
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.USER_FILE) {
    return documentTarget(resourceId);
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE) {
    return category === "team"
      ? genericTarget("team", resourceId, null)
      : genericTarget("matter", resourceId, matterName);
  }
  if (
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER ||
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT
  ) {
    return genericTarget("team", resourceId, null);
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK) {
    return genericTarget("court", resourceId, null);
  }
  return genericTarget("automation", resourceId, null);
};

type DeletedEntityTargetOptions = {
  category?: ActivityCategory;
  id: string;
  name?: string | null;
};

const deletedEntityTarget = ({
  category = "documents",
  id,
  name = null,
}: DeletedEntityTargetOptions): EntityTarget => ({
  deleted: true,
  encrypted: null,
  entityId: null,
  fieldId: null,
  id,
  kind: category === "tasks" ? "task" : "document",
  mimeType: null,
  name,
  pdfFileId: null,
  propertyId: null,
});

const documentTarget = (id: string): EntityTarget => ({
  ...deletedEntityTarget({ id }),
  deleted: false,
  encrypted: null,
});

const genericTarget = (
  kind: Exclude<ActivityTarget["kind"], "document" | "task">,
  id: string,
  name: string | null,
): ActivityTarget => ({
  deleted: false,
  encrypted: null,
  entityId: null,
  fieldId: null,
  id,
  kind,
  mimeType: null,
  name,
  pdfFileId: null,
  propertyId: null,
});

export default readOverviewActivity;
