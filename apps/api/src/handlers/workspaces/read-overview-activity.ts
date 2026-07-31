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
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { auditLogs, entityVersions, fields } from "@/api/db/schema";
import type { entities } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
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
  brandPersistedFieldId,
} from "@/api/lib/safe-id-boundaries";

const ACTIVITY_FILTERS = [
  "all",
  "documents",
  "tasks",
  "matter",
  "team",
  "court",
  "automation",
] as const;

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

const legacyCategoryCondition = (category: ActivityCategory): SQL => {
  switch (category) {
    case "documents":
      return (
        or(
          inArray(auditLogs.resourceType, [
            AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
            AUDIT_RESOURCE_TYPE.FIELD,
            AUDIT_RESOURCE_TYPE.USER_FILE,
          ]),
          and(
            eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.ENTITY),
            sql`coalesce(${auditLogs.metadata} ->> 'kind', '') <> 'task'`,
          ),
        ) ?? sql`false`
      );
    case "tasks":
      return (
        and(
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.ENTITY),
          sql`${auditLogs.metadata} ->> 'kind' = 'task'`,
        ) ?? sql`false`
      );
    case "matter":
      return eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.WORKSPACE);
    case "team":
      return inArray(auditLogs.resourceType, [
        AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER,
        AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT,
      ]);
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

const legacyActivityCategory = (
  resourceType: string,
  kind: string | null,
): ActivityCategory => {
  if (resourceType === AUDIT_RESOURCE_TYPE.ENTITY && kind === "task") {
    return "tasks";
  }
  if (
    resourceType === AUDIT_RESOURCE_TYPE.ENTITY ||
    resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION ||
    resourceType === AUDIT_RESOURCE_TYPE.FIELD ||
    resourceType === AUDIT_RESOURCE_TYPE.USER_FILE
  ) {
    return "documents";
  }
  if (
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER ||
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT
  ) {
    return "team";
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK) {
    return "court";
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE) {
    return "matter";
  }
  return "automation";
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
          ne(auditLogs.performerType, "user"),
          and(
            isNull(auditLogs.activityCategory),
            legacyCategoryCondition("automation"),
          ),
        ),
      );
    } else if (query.category && query.category !== "all") {
      const legacyCondition = legacyCategoryCondition(query.category);
      conditions.push(
        or(
          eq(auditLogs.activityCategory, query.category),
          and(isNull(auditLogs.activityCategory), legacyCondition),
        ),
      );
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
            id: auditLogs.id,
            legacyKind: sql<string | null>`${auditLogs.metadata} ->> 'kind'`,
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
        const fieldIds = rows
          .filter((row) => row.resourceType === AUDIT_RESOURCE_TYPE.FIELD)
          .map((row) => brandPersistedFieldId(row.resourceId));
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
          ]),
        ];
        const entityRows =
          entityIds.length === 0
            ? []
            : await tx.query.entities.findMany({
                limit: limit + 1,
                where: {
                  workspaceId: { eq: workspaceId },
                  id: { in: entityIds },
                },
                columns: { id: true, kind: true, name: true },
                with: {
                  currentVersion: {
                    columns: {},
                    with: {
                      fields: {
                        columns: {
                          id: true,
                          propertyId: true,
                          content: true,
                        },
                      },
                    },
                  },
                },
              });
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
                .innerJoin(
                  member,
                  and(
                    eq(member.userId, user.id),
                    eq(member.organizationId, session.activeOrganizationId),
                  ),
                )
                .where(inArray(user.id, actorIds));

        return { actors, entityRows, fieldRows, rows, versionRows, workspace };
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
    const fieldVersionMap = new Map(
      result.fieldRows.map((field) => [field.id, field.entityVersionId]),
    );
    const page = createCursorPage({
      rows: result.rows,
      limit,
      cursorForItem: (item) =>
        activityCursor.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      items: page.items.map((row) => {
        const performerId = row.performerId ?? row.userId;
        const category =
          row.activityCategory && row.activityCategory !== "other"
            ? row.activityCategory
            : legacyActivityCategory(row.resourceType, row.legacyKind);
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
  id: string;
  kind: (typeof entities.$inferSelect)["kind"];
  name: string;
  currentVersion: {
    fields: {
      id: string;
      propertyId: string;
      content: FieldContent;
    }[];
  } | null;
};

const toEntityTarget = (entity: EntityRow): EntityTarget => {
  const fileField = entity.currentVersion?.fields.find(
    (field) => field.content.type === "file",
  );
  const fileContent =
    fileField?.content.type === "file" ? fileField.content : null;
  return {
    deleted: false,
    entityId: entity.id,
    fieldId: fileField?.id ?? null,
    id: entity.id,
    kind: entity.kind === "task" ? "task" : "document",
    mimeType: fileContent?.mimeType ?? null,
    name: fileContent?.fileName ?? entity.name,
    pdfFileId: fileContent?.pdfFileId ?? null,
    propertyId: fileField?.propertyId ?? null,
  };
};

type TargetForRowOptions = {
  category: ActivityCategory;
  entityMap: Map<string, EntityTarget>;
  fieldVersionMap: Map<string, string>;
  matterName: string | null;
  resourceId: string;
  resourceType: string;
  versionEntityMap: Map<string, string>;
};

const targetForRow = ({
  category,
  entityMap,
  fieldVersionMap,
  matterName,
  resourceId,
  resourceType,
  versionEntityMap,
}: TargetForRowOptions): ActivityTarget => {
  if (resourceType === AUDIT_RESOURCE_TYPE.ENTITY) {
    return entityMap.get(resourceId) ?? deletedEntityTarget(resourceId);
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION) {
    const entityId = versionEntityMap.get(resourceId);
    if (entityId) {
      return entityMap.get(entityId) ?? deletedEntityTarget(entityId);
    }
    return deletedEntityTarget(resourceId);
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.FIELD) {
    const versionId = fieldVersionMap.get(resourceId);
    const entityId = versionId ? versionEntityMap.get(versionId) : null;
    if (entityId) {
      return entityMap.get(entityId) ?? deletedEntityTarget(entityId);
    }
    return deletedEntityTarget(resourceId);
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

const deletedEntityTarget = (id: string): EntityTarget => ({
  deleted: true,
  entityId: null,
  fieldId: null,
  id,
  kind: "document",
  mimeType: null,
  name: null,
  pdfFileId: null,
  propertyId: null,
});

const documentTarget = (id: string): EntityTarget => ({
  ...deletedEntityTarget(id),
  deleted: false,
});

const genericTarget = (
  kind: Exclude<ActivityTarget["kind"], "document" | "task">,
  id: string,
  name: string | null,
): ActivityTarget => ({
  deleted: false,
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
