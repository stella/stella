import { panic, Result } from "better-result";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { isEntityKind } from "@stll/api-contract";
import type {
  MatterActivityAction,
  MatterActivityCategory,
  MatterActivityFilters,
} from "@stll/api-contract/matter-activity";

// eslint-disable-next-line security-guards/no-unscoped-user-query -- actor IDs come only from audit rows already scoped to the authorized organization and workspace; membership joins would erase retained attribution after membership ends.
import { user } from "@/api/db/auth-schema";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  auditActivityActionSql,
  auditLogs,
  auditRelationshipChangeSql,
  contacts,
  documentReviewRuns,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { createCursorPage } from "@/api/lib/pagination";
import {
  brandPersistedAuditLogId,
  brandPersistedDocumentReviewRunId,
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
} from "@/api/lib/safe-id-boundaries";

import {
  activityTargetSource,
  bindActivityCursorToFilters,
  FEED_ACTIVITY_RESOURCE_TYPES,
  parseFieldAuditResourceId,
  resolveActivityAction,
  resolveActivityCategory,
  resolveActivityRunId,
  timestampMicroseconds,
  VISIBLE_ACTIVITY_ACTIONS,
  type VisibleActivityAction,
} from "./read-overview-activity.logic";

const versionSnapshotAuditLogs = alias(
  auditLogs,
  "version_snapshot_audit_logs",
);
const entitySnapshotAuditLogs = alias(auditLogs, "entity_snapshot_audit_logs");
const contactSnapshotAuditLogs = alias(
  auditLogs,
  "contact_snapshot_audit_logs",
);

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

export const visibleActivityCondition = () =>
  and(
    inArray(auditLogs.action, VISIBLE_ACTIVITY_ACTIONS),
    // Every feed row must resolve to a named target, so the query admits only
    // the resource types the projection names. A resource excluded there can
    // never arrive here to be labelled generically.
    inArray(auditLogs.resourceType, FEED_ACTIVITY_RESOURCE_TYPES),
    // "other" is housekeeping — session expiry, retention sweeps — and stays
    // out of the matter's story no matter who performed it. The performer
    // test only rescues rows written before activityCategory existed.
    or(
      and(
        isNotNull(auditLogs.activityCategory),
        ne(auditLogs.activityCategory, "other"),
      ),
      and(
        isNull(auditLogs.activityCategory),
        or(
          ne(auditLogs.performerType, "user"),
          inArray(auditLogs.resourceType, LEGACY_VISIBLE_RESOURCE_TYPES),
        ),
      ),
    ),
  ) ?? sql`false`;

const historicalActorId = () =>
  sql<string>`coalesce(${auditLogs.performerId}, ${auditLogs.userId})`;

type ReadOverviewActivityActorRowsOptions = {
  afterActorId: string | null;
  limit: number;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  search: string;
  workspaceId: SafeId<"workspace">;
};

export const readOverviewActivityActorRows = async ({
  afterActorId,
  limit,
  organizationId,
  safeDb,
  search,
  workspaceId,
}: ReadOverviewActivityActorRowsOptions) =>
  await safeDb(async (tx) => {
    const actorId = historicalActorId();
    const conditions = [
      eq(auditLogs.organizationId, organizationId),
      eq(auditLogs.workspaceId, workspaceId),
      eq(auditLogs.performerType, "user"),
      visibleActivityCondition(),
    ];
    if (afterActorId !== null) {
      conditions.push(gt(actorId, afterActorId));
    }
    const historicalActors = tx
      .selectDistinct({ id: actorId.as("actor_id") })
      .from(auditLogs)
      .where(and(...conditions))
      .as("historical_activity_actors");
    const identityCondition =
      search === ""
        ? sql`true`
        : (or(
            ilike(user.name, `%${escapeLike(search)}%`),
            ilike(user.email, `%${escapeLike(search)}%`),
          ) ?? sql`false`);

    return await tx
      .selectDistinct({
        deletedAt: user.deletedAt,
        email: user.email,
        id: historicalActors.id,
        image: user.image,
        name: user.name,
      })
      .from(historicalActors)
      // The actor ID comes from an organization-and-workspace-scoped audit
      // row, so attribution remains authorized after membership ends.
      .leftJoin(user, eq(user.id, historicalActors.id))
      .where(identityCondition)
      .orderBy(asc(historicalActors.id))
      .limit(limit + 1);
  });

type ActivityCategory = Exclude<MatterActivityCategory, "all">;

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
  from ${auditLogs} as "version_snapshot_audit_logs"
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

const resolvedAuditEntityIdSnapshot = () => sql<string | null>`coalesce(
  ${auditEntityIdSnapshot()},
  ${siblingVersionEntityIdSnapshot()}
)`;

const auditEntityNameSnapshot = () => sql<string | null>`coalesce(
  ${auditLogs.metadata} ->> 'entityName',
  ${auditLogs.metadata} ->> 'fileName',
  ${auditLogs.changes} -> 'created' -> 'new' ->> 'name',
  ${auditLogs.changes} -> 'created' -> 'new' ->> 'fileName',
  ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'fileName',
  ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
)`;

const auditEntityMimeTypeSnapshot = () => sql<string | null>`coalesce(
  ${auditLogs.metadata} ->> 'mimeType',
  ${auditLogs.changes} -> 'created' -> 'new' ->> 'mimeType',
  ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'mimeType'
)`;

const siblingVersionEntityNameSnapshot = () => sql<string | null>`(
  select coalesce(
    ${versionSnapshotAuditLogs.metadata} ->> 'entityName',
    ${versionSnapshotAuditLogs.metadata} ->> 'fileName',
    ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'name',
    ${versionSnapshotAuditLogs.changes} -> 'created' -> 'new' ->> 'fileName',
    ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'fileName',
    ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
  )
  from ${auditLogs} as "version_snapshot_audit_logs"
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
      ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'fileName',
      ${versionSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
    ) is not null
  order by ${versionSnapshotAuditLogs.createdAt}, ${versionSnapshotAuditLogs.id}
  limit 1
)`;

const siblingDeletedEntityKind = () => sql<string | null>`(
  select ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'kind'
  from ${auditLogs} as "entity_snapshot_audit_logs"
  where ${entitySnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
    and ${entitySnapshotAuditLogs.workspaceId} = ${auditLogs.workspaceId}
    and ${entitySnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entitySnapshotAuditLogs.resourceId} = ${resolvedAuditEntityIdSnapshot()}
    and ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'kind' is not null
  order by ${entitySnapshotAuditLogs.createdAt} desc, ${entitySnapshotAuditLogs.id} desc
  limit 1
)`;

const siblingDeletedEntityName = () => sql<string | null>`(
  select coalesce(
    ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'fileName',
    ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
  )
  from ${auditLogs} as "entity_snapshot_audit_logs"
  where ${entitySnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
    and ${entitySnapshotAuditLogs.workspaceId} = ${auditLogs.workspaceId}
    and ${entitySnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entitySnapshotAuditLogs.resourceId} = ${resolvedAuditEntityIdSnapshot()}
    and coalesce(
      ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'fileName',
      ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'name'
    ) is not null
  order by ${entitySnapshotAuditLogs.createdAt} desc, ${entitySnapshotAuditLogs.id} desc
  limit 1
)`;

const siblingDeletedEntityMimeType = () => sql<string | null>`(
  select ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'mimeType'
  from ${auditLogs} as "entity_snapshot_audit_logs"
  where ${entitySnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
    and ${entitySnapshotAuditLogs.workspaceId} = ${auditLogs.workspaceId}
    and ${entitySnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.ENTITY}
    and ${entitySnapshotAuditLogs.resourceId} = ${resolvedAuditEntityIdSnapshot()}
    and ${entitySnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'mimeType' is not null
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

// True when the audit row's only recorded change is the name, so the client
// can distinguish a rename from other updates (a move records `parentId`).
const renameOnlyChange = () => sql<boolean>`coalesce((
  ${auditLogs.changes} ? 'name'
  and (select count(*) = 1 from jsonb_object_keys(${auditLogs.changes}))
), false)`;

// The reviewed document's name as the run pinned it, so a review whose run
// row is gone still names what it reviewed.
const auditReviewDocumentName = () => sql<string | null>`case
  when ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN}
    then ${auditLogs.metadata} ->> 'documentName'
  else null
end`;

const teamContactIdSnapshot = () => sql<string | null>`case
  when ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT}
    then coalesce(
      ${auditLogs.changes} -> 'created' -> 'new' ->> 'contactId',
      ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'contactId'
    )
  else null
end`;

const teamContactNameSnapshot = () => sql<string | null>`coalesce(
  (
    select ${contacts.displayName}
    from ${contacts}
    where ${contacts.organizationId} = ${auditLogs.organizationId}
      and ${contacts.id} = case
        when ${teamContactIdSnapshot()} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then ${teamContactIdSnapshot()}::uuid
        else null
      end
    limit 1
  ),
  (
    select ${contactSnapshotAuditLogs.changes} -> 'deleted' -> 'old' ->> 'displayName'
    from ${auditLogs} as "contact_snapshot_audit_logs"
    where ${contactSnapshotAuditLogs.organizationId} = ${auditLogs.organizationId}
      and ${contactSnapshotAuditLogs.workspaceId} is null
      and ${contactSnapshotAuditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.CONTACT}
      and ${contactSnapshotAuditLogs.resourceId} = ${teamContactIdSnapshot()}
    order by ${contactSnapshotAuditLogs.createdAt} desc
    limit 1
  )
)`;

const teamUserIdSnapshot = () => sql<string | null>`case
  when ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER}
    then coalesce(
      ${auditLogs.changes} -> 'created' -> 'new' ->> 'userId',
      ${auditLogs.changes} -> 'deleted' -> 'old' ->> 'userId'
    )
  when ${auditLogs.resourceType} = ${AUDIT_RESOURCE_TYPE.WORKSPACE}
    and jsonb_array_length(
      case
        when jsonb_typeof(${auditLogs.changes} -> 'membersAdded' -> 'new') = 'array'
          then ${auditLogs.changes} -> 'membersAdded' -> 'new'
        else '[]'::jsonb
      end
    ) = 1
    then ${auditLogs.changes} -> 'membersAdded' -> 'new' ->> 0
  else null
end`;

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
      category satisfies never;
      return panic(`Unhandled category: ${String(category)}`);
    }
  }
};

const activityActionCondition = (action: MatterActivityAction): SQL => {
  if (action === "all") {
    return sql`true`;
  }
  return sql`${auditActivityActionSql(auditLogs)} = ${action}`;
};

const activityCursor = createTimestampIdCursorCodec({
  column: auditLogs.createdAt,
  brandId: brandPersistedAuditLogId,
});

type ActivityTarget = {
  // Matter colour, so a `matter` target renders its own glyph colour
  // instead of a mono one. Null for every other kind.
  color: string | null;
  deleted: boolean;
  encrypted: boolean | null;
  entityId: string | null;
  fieldId: string | null;
  id: string;
  kind:
    | EntityTargetKind
    | "automation"
    | "court"
    | "documentReviewRun"
    | "matter"
    | "playbook"
    | "team"
    | "translationRun";
  mimeType: string | null;
  name: string | null;
  pdfFileId: string | null;
  propertyId: string | null;
};

// Derived from the entities column enum (itself from ENTITY_KINDS), so the
// activity contract cannot drift from the persisted kind set.
type EntityTargetKind = (typeof entities.$inferSelect)["kind"];

type EntityTarget = Omit<ActivityTarget, "kind"> & {
  kind: EntityTargetKind;
};

type ActivityUser = {
  deletedAt: string | null;
  id: string;
  image: string | null;
  name: string | null;
  type: "user";
};

export type MatterActivityItem = {
  action: VisibleActivityAction | "add" | "remove";
  activityAt: string;
  approval: {
    status: (typeof auditLogs.$inferSelect)["approvalStatus"];
    user: ActivityUser | null;
  };
  category: ActivityCategory;
  id: SafeId<"auditLog">;
  performer:
    | ActivityUser
    | {
        name: string | null;
        type: Exclude<(typeof auditLogs.$inferSelect)["performerType"], "user">;
      };
  /** The event's only recorded change is the target's name. */
  renameOnly: boolean;
  runId: string | null;
  target: ActivityTarget;
  trigger: {
    source: string | null;
    type: (typeof auditLogs.$inferSelect)["triggerType"];
    user: ActivityUser | null;
  };
};

export type MatterActivityPage = {
  items: MatterActivityItem[];
  limit: number;
  nextCursor: string | null;
};

type ReadOverviewActivityPageOptions = {
  cursor: string | null;
  filters: MatterActivityFilters;
  limit: number;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

export const readOverviewActivityPage = async ({
  cursor: cursorValue,
  filters,
  limit,
  organizationId,
  safeDb,
  workspaceId,
}: ReadOverviewActivityPageOptions): Promise<
  Result<MatterActivityPage, HandlerError | SafeDbError>
> =>
  await Result.gen(async function* () {
    const fromDate =
      filters.from === null ? null : timestampMicroseconds(filters.from);
    const toExclusiveDate =
      filters.toExclusive === null
        ? null
        : timestampMicroseconds(filters.toExclusive);
    if (
      (filters.from !== null && fromDate === null) ||
      (filters.toExclusive !== null && toExclusiveDate === null) ||
      (fromDate !== null &&
        toExclusiveDate !== null &&
        fromDate >= toExclusiveDate)
    ) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid date range" }),
      );
    }
    const filteredCursor = bindActivityCursorToFilters({
      codec: activityCursor,
      filters,
    });
    const cursor = cursorValue ? filteredCursor.decode(cursorValue) : null;
    if (cursorValue !== null && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const conditions = [
      eq(auditLogs.organizationId, organizationId),
      eq(auditLogs.workspaceId, workspaceId),
      visibleActivityCondition(),
    ];

    if (filters.action !== "all") {
      conditions.push(activityActionCondition(filters.action));
    }
    if (filters.actorId !== null) {
      conditions.push(
        and(
          eq(auditLogs.performerType, "user"),
          sql`coalesce(${auditLogs.performerId}, ${auditLogs.userId}) = ${filters.actorId}`,
        ) ?? sql`false`,
      );
    }
    if (fromDate !== null) {
      conditions.push(
        sql`${auditLogs.createdAt} >= ${filters.from}::timestamptz`,
      );
    }
    if (toExclusiveDate !== null) {
      conditions.push(
        sql`${auditLogs.createdAt} < ${filters.toExclusive}::timestamptz`,
      );
    }

    if (filters.category === "automation") {
      conditions.push(
        or(
          eq(auditLogs.activityCategory, "automation"),
          and(
            isNull(auditLogs.activityCategory),
            or(
              ne(auditLogs.performerType, "user"),
              legacyCategoryCondition("automation"),
            ),
          ),
        ) ?? sql`false`,
      );
    } else if (filters.category !== "all") {
      const legacyCondition = legacyCategoryCondition(filters.category);
      const storedOrLegacyCategory =
        or(
          eq(auditLogs.activityCategory, filters.category),
          and(isNull(auditLogs.activityCategory), legacyCondition),
        ) ?? sql`false`;
      if (filters.category === "tasks") {
        conditions.push(
          or(storedOrLegacyCategory, taskEntityResourceCondition()) ??
            sql`false`,
        );
      } else if (filters.category === "documents") {
        conditions.push(
          and(
            storedOrLegacyCategory,
            sql`NOT coalesce(${taskEntityResourceCondition()}, false)`,
          ) ?? sql`false`,
        );
      } else {
        conditions.push(storedOrLegacyCategory);
      }
    }
    if (cursor) {
      const cursorCondition = filteredCursor.keysetAfter({
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
            action: sql<VisibleActivityAction>`${auditLogs.action}`,
            activityCategory: auditLogs.activityCategory,
            approvalStatus: auditLogs.approvalStatus,
            approvedByUserId: auditLogs.approvedByUserId,
            createdAt: auditLogs.createdAt,
            createdAtCursor: activityCursor.cursorValue.as("created_at_cursor"),
            entityIdSnapshot: resolvedAuditEntityIdSnapshot(),
            entityMimeTypeSnapshot: sql<string | null>`coalesce(
              ${auditEntityMimeTypeSnapshot()},
              ${siblingDeletedEntityMimeType()}
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
            reviewDocumentNameSnapshot: auditReviewDocumentName(),
            relationshipChange: auditRelationshipChangeSql(auditLogs),
            renameOnly: renameOnlyChange(),
            runId: auditLogs.runId,
            triggerSource: auditLogs.triggerSource,
            triggerType: auditLogs.triggerType,
            triggerUserId: auditLogs.triggerUserId,
            teamContactNameSnapshot: teamContactNameSnapshot(),
            teamUserIdSnapshot: teamUserIdSnapshot(),
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
        // A review row names its run; what the reader needs is the document
        // that was reviewed, which the run row holds. The audit metadata
        // carries the same identity for a run that has since been deleted.
        const reviewRunIds = rows
          .filter(
            (row) =>
              row.resourceType === AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
          )
          .map((row) => brandPersistedDocumentReviewRunId(row.resourceId));
        const reviewRunRows =
          reviewRunIds.length === 0
            ? []
            : await tx
                .select({
                  entityId: documentReviewRuns.entityId,
                  id: documentReviewRuns.id,
                })
                .from(documentReviewRuns)
                .where(
                  and(
                    eq(documentReviewRuns.workspaceId, workspaceId),
                    inArray(documentReviewRuns.id, reviewRunIds),
                  ),
                );
        const entityIds = [
          ...new Set([
            ...directEntityIds,
            ...versionRows.map((row) => row.entityId),
            ...reviewRunRows.map((row) => brandPersistedEntityId(row.entityId)),
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
          order by ${fields.id}
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
                );
        const workspace = await tx.query.workspaces.findFirst({
          where: {
            id: { eq: workspaceId },
            organizationId: { eq: organizationId },
          },
          columns: { color: true, name: true },
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
                row.teamUserIdSnapshot,
              ])
              .filter((id): id is string => id !== null),
          ),
        ];
        const actors =
          actorIds.length === 0
            ? []
            : await tx
                .selectDistinct({
                  deletedAt: user.deletedAt,
                  email: user.email,
                  id: user.id,
                  image: user.image,
                  name: user.name,
                })
                .from(user)
                .where(
                  // Actor IDs originate only from the organization-and-
                  // workspace-scoped rows above, preserving audit attribution
                  // after membership ends without widening the identity set.
                  inArray(user.id, actorIds),
                );
        return {
          actors,
          compositeFieldVersions,
          entityRows,
          fieldRows,
          reviewRunRows,
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
          id: actor.id,
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
    const reviewRunEntityMap = new Map<string, string>(
      result.reviewRunRows.map((run) => [run.id, run.entityId]),
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
        filteredCursor.encode(item.createdAtCursor, item.id),
    });

    const payload: MatterActivityPage = {
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
                id: performerId,
                image: null,
                name: null,
                type: "user" as const,
              })
            : {
                name: row.performerName,
                type: row.performerType,
              };

        return {
          action: resolveActivityAction({
            action: row.action,
            relationshipChange: row.relationshipChange,
          }),
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
          renameOnly: row.renameOnly,
          runId: resolveActivityRunId({
            resourceId: row.resourceId,
            resourceType: row.resourceType,
            runId: row.runId,
          }),
          target: targetForRow({
            category,
            entityMap,
            entityIdSnapshot: row.entityIdSnapshot,
            entityKindSnapshot: row.legacyKind,
            entityMimeTypeSnapshot: row.entityMimeTypeSnapshot,
            entityNameSnapshot: row.entityNameSnapshot,
            fieldVersionMap,
            matterColor: result.workspace?.color ?? null,
            matterName: result.workspace?.name ?? null,
            resourceId: row.resourceId,
            resourceType: row.resourceType,
            reviewDocumentNameSnapshot: row.reviewDocumentNameSnapshot,
            reviewRunEntityMap,
            teamTargetName: row.teamUserIdSnapshot
              ? (actorMap.get(row.teamUserIdSnapshot)?.name ?? null)
              : row.teamContactNameSnapshot,
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
    };

    return Result.ok(payload);
  });

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
  const file = entity.kind === "task" ? null : entity.file;
  return {
    color: null,
    deleted: false,
    encrypted: file?.encrypted ?? null,
    entityId: entity.id,
    fieldId: file?.id ?? null,
    id: entity.id,
    kind: entity.kind,
    mimeType: file?.mimeType ?? null,
    name: file?.fileName ?? entity.name,
    pdfFileId: file?.pdfFileId ?? null,
    propertyId: file?.propertyId ?? null,
  };
};

type TargetForRowOptions = {
  category: ActivityCategory;
  entityMap: Map<string, EntityTarget>;
  entityIdSnapshot: string | null;
  entityKindSnapshot: string | null;
  entityMimeTypeSnapshot: string | null;
  entityNameSnapshot: string | null;
  fieldVersionMap: Map<string, string>;
  matterColor: string | null;
  matterName: string | null;
  resourceId: string;
  resourceType: string;
  reviewDocumentNameSnapshot: string | null;
  reviewRunEntityMap: Map<string, string>;
  teamTargetName: string | null;
  versionEntityMap: Map<string, string>;
};

const targetForRow = ({
  category,
  entityMap,
  entityIdSnapshot,
  entityKindSnapshot,
  entityMimeTypeSnapshot,
  entityNameSnapshot,
  fieldVersionMap,
  matterColor,
  matterName,
  resourceId,
  resourceType,
  reviewDocumentNameSnapshot,
  reviewRunEntityMap,
  teamTargetName,
  versionEntityMap,
}: TargetForRowOptions): ActivityTarget => {
  const entityTarget = (entityId: string): ActivityTarget =>
    entityMap.get(entityId) ??
    deletedEntityTarget({
      category,
      id: entityId,
      kindSnapshot: entityKindSnapshot,
      mimeType: entityMimeTypeSnapshot,
      name: entityNameSnapshot,
    });

  const source = activityTargetSource(resourceType);
  switch (source) {
    case "entity":
      return entityTarget(resourceId);
    case "entityVersion": {
      const entityId = versionEntityMap.get(resourceId) ?? entityIdSnapshot;
      return entityId
        ? entityTarget(entityId)
        : deletedEntityTarget({ category, id: resourceId, name: null });
    }
    case "field": {
      const versionId = fieldVersionMap.get(resourceId);
      const entityId =
        (versionId ? versionEntityMap.get(versionId) : null) ??
        entityIdSnapshot;
      return entityId
        ? entityTarget(entityId)
        : deletedEntityTarget({ category, id: resourceId, name: null });
    }
    case "userFile":
      return documentTarget(resourceId);
    case "workspace":
      return category === "team"
        ? genericTarget({
            color: null,
            id: resourceId,
            kind: "team",
            name: teamTargetName,
          })
        : genericTarget({
            color: matterColor,
            id: resourceId,
            kind: "matter",
            name: matterName,
          });
    case "team":
      return genericTarget({
        color: null,
        id: resourceId,
        kind: "team",
        name: teamTargetName,
      });
    case "court":
      return genericTarget({
        color: null,
        id: resourceId,
        kind: "court",
        name: null,
      });
    case "documentReviewRun": {
      // The row is about the reviewed document: it carries the document's
      // identity so the feed can name it and open it, keeping the run's own
      // id so consecutive decisions on one review stay one row.
      const entityId = reviewRunEntityMap.get(resourceId) ?? entityIdSnapshot;
      const document = entityId ? entityMap.get(entityId) : undefined;
      if (!document) {
        return genericTarget({
          color: null,
          id: resourceId,
          kind: "documentReviewRun",
          name: reviewDocumentNameSnapshot,
        });
      }
      return {
        color: null,
        deleted: document.deleted,
        encrypted: document.encrypted,
        entityId: document.entityId,
        fieldId: document.fieldId,
        id: resourceId,
        kind: "documentReviewRun",
        mimeType: document.mimeType,
        name: document.name,
        pdfFileId: document.pdfFileId,
        propertyId: document.propertyId,
      };
    }
    case "translationRun":
      return genericTarget({
        color: null,
        id: resourceId,
        kind: "translationRun",
        name: null,
      });
    case "playbook":
      return genericTarget({
        color: null,
        id: resourceId,
        kind: "playbook",
        name: entityNameSnapshot,
      });
    case "automation":
      return genericTarget({
        color: null,
        id: resourceId,
        kind: "automation",
        name: null,
      });
    default: {
      source satisfies never;
      return panic(`Unhandled source: ${String(source)}`);
    }
  }
};

type DeletedEntityTargetOptions = {
  category?: ActivityCategory;
  id: string;
  /** Kind recorded in the audit snapshot; the entity row itself is gone. */
  kindSnapshot?: string | null;
  mimeType?: string | null;
  name?: string | null;
};

const deletedEntityKind = (
  category: ActivityCategory,
  kindSnapshot: string | null,
): EntityTargetKind => {
  if (isEntityKind(kindSnapshot)) {
    return kindSnapshot;
  }
  return category === "tasks" ? "task" : "document";
};

const deletedEntityTarget = ({
  category = "documents",
  id,
  kindSnapshot = null,
  mimeType = null,
  name = null,
}: DeletedEntityTargetOptions): EntityTarget => ({
  color: null,
  deleted: true,
  encrypted: null,
  entityId: null,
  fieldId: null,
  id,
  kind: deletedEntityKind(category, kindSnapshot),
  mimeType,
  name,
  pdfFileId: null,
  propertyId: null,
});

const documentTarget = (id: string): EntityTarget => ({
  ...deletedEntityTarget({ id }),
  deleted: false,
  encrypted: null,
});

type GenericTargetOptions = {
  color: string | null;
  id: string;
  kind: Exclude<ActivityTarget["kind"], EntityTarget["kind"]>;
  name: string | null;
};

const genericTarget = ({
  color,
  id,
  kind,
  name,
}: GenericTargetOptions): ActivityTarget => ({
  color,
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
