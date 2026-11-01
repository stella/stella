import { panic, Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, gte, inArray, lt, lte, not, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  API_STORABLE_INSTANT_CHECK,
  apiDateTimeSchema,
} from "@stll/api-contract/api-date";
import {
  AUDIT_CHANGES_STATUS,
  AUDIT_PERFORMER_FILTER,
} from "@stll/api-contract/audit-log";
import { numberFromString } from "@stll/api-contract/http-input";

import { member, user } from "@/api/db/auth-schema";
import { workspaceCheck } from "@/api/db/rls";
import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs, auditPeoplePerformerSql } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  auditReadChangesSql,
  auditStoredChangesPresentSql,
  projectAuditReadChanges,
} from "@/api/lib/audit-log-details";
import type { SafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  resourceIdSchema,
  userIdSchema,
  withDescription,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import type {
  FeatureAccessPrincipal,
  FeatureAccessSnapshot,
} from "@/api/lib/feature-access/policy";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedAuditLogId } from "@/api/lib/safe-id-boundaries";

import { resolveAuditResourceNames } from "./resource-resolvers";

const auditLogCursor = createTimestampIdCursorCodec({
  column: auditLogs.createdAt,
  brandId: brandPersistedAuditLogId,
});

export const readAuditLogsQuerySchema = v.object({
  workspaceId: v.exactOptional(
    resourceIdSchema("workspace", {
      description: "Only entries scoped to this matter",
    }),
  ),
  action: v.exactOptional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Only entries with this audit action"),
    ),
  ),
  resourceType: v.exactOptional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Only entries about this resource type"),
    ),
  ),
  resourceId: v.exactOptional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.description(
        "Only entries about this resource id; requires resourceType",
      ),
    ),
  ),
  userId: v.exactOptional(
    withDescription(userIdSchema, "Only entries whose actor is this user"),
  ),
  performer: v.exactOptional(
    v.pipe(
      v.picklist(Object.values(AUDIT_PERFORMER_FILTER)),
      v.description(
        "Only entries performed by people (members and their agents), or only by automations (background services)",
      ),
    ),
  ),
  from: v.exactOptional(
    v.pipe(
      v.string(),
      v.isoTimestamp(),
      API_STORABLE_INSTANT_CHECK,
      v.description("Only entries created on or after this ISO date-time"),
    ),
  ),
  to: v.exactOptional(
    v.pipe(
      v.string(),
      v.isoTimestamp(),
      API_STORABLE_INSTANT_CHECK,
      v.description("Only entries created on or before this ISO date-time"),
    ),
  ),
  toExclusive: v.exactOptional(apiDateTimeSchema),
  limit: v.exactOptional(
    numberFromString(
      v.pipe(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.auditLogPageSizeMax),
        ),
        v.description("Max entries to return"),
      ),
    ),
  ),
  cursor: v.exactOptional(paginationCursorSchema()),
});

export type ReadAuditLogsQuery = v.InferOutput<typeof readAuditLogsQuerySchema>;

/**
 * The WHERE conditions of a compliance read: organization and matter access, then
 * the caller's filter narrowing inside it. The organization comes first and
 * from the server, so a filter can only narrow the rows a caller could already
 * read, never widen them.
 */
export const toAuditLogConditions = ({
  organizationId,
  filter,
}: {
  organizationId: SafeId<"organization">;
  filter: AuditLogFilter;
}): SQL[] => {
  const conditions: SQL[] = [
    eq(auditLogs.organizationId, organizationId),
    sql`(${auditLogs.workspaceId} IS NULL OR ${workspaceCheck})`,
  ];

  if (filter.workspaceId) {
    conditions.push(eq(auditLogs.workspaceId, filter.workspaceId));
  }
  if (filter.action) {
    conditions.push(eq(auditLogs.action, filter.action));
  }
  if (filter.resourceType) {
    conditions.push(eq(auditLogs.resourceType, filter.resourceType));
  }
  if (filter.resourceId) {
    conditions.push(eq(auditLogs.resourceId, filter.resourceId));
  }
  if (filter.userId) {
    conditions.push(eq(auditLogs.userId, filter.userId));
  }
  switch (filter.performer) {
    case undefined:
      break;
    case AUDIT_PERFORMER_FILTER.people:
      conditions.push(auditPeoplePerformerSql(auditLogs.performerType));
      break;
    case AUDIT_PERFORMER_FILTER.automations:
      conditions.push(not(auditPeoplePerformerSql(auditLogs.performerType)));
      break;
    default:
      filter.performer satisfies never;
      return panic("Unhandled audit performer filter");
  }
  if (filter.from) {
    // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- caller-supplied filter bound, never round-tripped through the database
    conditions.push(gte(auditLogs.createdAt, new Date(filter.from)));
  }
  if (filter.to) {
    // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- caller-supplied filter bound, never round-tripped through the database
    conditions.push(lte(auditLogs.createdAt, new Date(filter.to)));
  }
  if (filter.toExclusive) {
    // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- caller-supplied filter bound, never round-tripped through the database
    conditions.push(lt(auditLogs.createdAt, new Date(filter.toExclusive)));
  }
  if (filter.cursor) {
    const cursor = auditLogCursor.decode(filter.cursor);
    if (!cursor) {
      return conditions;
    }

    const cursorCondition = auditLogCursor.keysetAfter({
      cursor,
      idColumn: auditLogs.id,
      direction: "descending",
    });
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  return conditions;
};

const VALID_ACTIONS = new Set<string>(Object.values(AUDIT_ACTION));
const VALID_RESOURCE_TYPES = new Set<string>(
  Object.values(AUDIT_RESOURCE_TYPE),
);
const AUDIT_RESOURCE_KIND_SCHEMA = v.picklist(
  Object.values(AUDIT_RESOURCE_TYPE),
);

type ClassifiedAuditResourceKind =
  | { type: "known"; kind: v.InferOutput<typeof AUDIT_RESOURCE_KIND_SCHEMA> }
  | { type: "unknown"; raw: string };

const classifyAuditResourceKind = (
  value: string,
): ClassifiedAuditResourceKind => {
  if (VALID_RESOURCE_TYPES.has(value)) {
    return { type: "known", kind: v.parse(AUDIT_RESOURCE_KIND_SCHEMA, value) };
  }
  return { type: "unknown", raw: value };
};

/**
 * Compliance-read filter over the org's append-only audit trail. Shared shape
 * for the HTTP handler and the `read_audit_log` MCP tool so both apply the same
 * filter surface, keyset cursor, and rejections.
 */
export type AuditLogFilter = ReadAuditLogsQuery;

/**
 * Replicates every 400 the read path rejects on before any query runs
 * (unknown action / resource type, resourceId without resourceType, malformed
 * cursor). Returns the human-readable reason, or null when the filter is valid.
 * Both transports call it up front so a bad filter fails identically.
 */
export const validateAuditLogFilter = (
  query: AuditLogFilter,
): string | null => {
  if (query.action !== undefined && !VALID_ACTIONS.has(query.action)) {
    return `Unknown action filter '${query.action}'`;
  }
  if (
    query.resourceType !== undefined &&
    !VALID_RESOURCE_TYPES.has(query.resourceType)
  ) {
    return `Unknown resourceType filter '${query.resourceType}'`;
  }
  if (query.resourceId && !query.resourceType) {
    return "resourceType is required when resourceId is provided";
  }
  if (query.cursor && !auditLogCursor.decode(query.cursor)) {
    return "Invalid cursor";
  }
  return null;
};

type AuditLogRow = typeof auditLogs.$inferSelect;

/**
 * The name a reader recognises: the member's name, or the name a background
 * service declared, before the stored actor id.
 */
const auditActorName = (
  row: Pick<AuditLogRow, "userId" | "performerType" | "performerName">,
  members: ReadonlyMap<string, string>,
) =>
  (row.performerType === "service" ? row.performerName : null) ??
  members.get(row.userId) ??
  row.userId;

type AuditLogPageRow = Pick<
  AuditLogRow,
  | "id"
  | "createdAt"
  | "userId"
  | "performerType"
  | "performerName"
  | "action"
  | "resourceType"
  | "resourceId"
  | "changes"
  | "metadata"
> & { createdAtCursor: string; hasStoredChanges: boolean };

type AuditResourceNames = Awaited<ReturnType<typeof resolveAuditResourceNames>>;

const toAuditResource = ({
  row,
  resourceKind,
  resourceNames,
}: {
  row: Pick<AuditLogRow, "resourceId">;
  resourceKind: ClassifiedAuditResourceKind;
  resourceNames: AuditResourceNames;
}) =>
  resourceKind.type === "known"
    ? {
        kind: resourceKind.kind,
        id: row.resourceId,
        name: resourceNames.get(resourceKind.kind)?.get(row.resourceId) ?? null,
        available:
          resourceNames.get(resourceKind.kind)?.has(row.resourceId) ?? false,
      }
    : {
        kind: "unknown" as const,
        rawKind: resourceKind.raw,
        id: row.resourceId,
        name: null,
        available: false as const,
      };

const toAuditLogPageItem = ({
  row,
  resourceKind,
  resourceNames,
  members,
  featureAccessSnapshot,
  principal,
}: {
  row: AuditLogPageRow;
  resourceKind: ClassifiedAuditResourceKind;
  resourceNames: AuditResourceNames;
  members: ReadonlyMap<string, string>;
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
  principal: FeatureAccessPrincipal;
}) => ({
  id: row.id,
  createdAt: row.createdAt,
  action: row.action,
  resourceType: row.resourceType,
  resourceId: row.resourceId,
  resource: toAuditResource({ row, resourceKind, resourceNames }),
  ...(resourceKind.type === "known"
    ? projectAuditReadChanges({
        resourceType: resourceKind.kind,
        changes: row.changes,
        metadata: row.metadata,
        featureAccessSnapshot,
        principal,
      })
    : {
        changes: null,
        changesStatus: row.hasStoredChanges
          ? AUDIT_CHANGES_STATUS.unrecognizedResource
          : AUDIT_CHANGES_STATUS.visible,
      }),
  createdAtCursor: row.createdAtCursor,
  userId: row.userId,
  performerType: row.performerType,
  actor: auditActorName(row, members),
});

// Columns the compliance read does not send to the client.
const UNPROJECTED_AUDIT_LOG_COLUMNS = [
  // Tenant scope, implied by the caller's active organization.
  "organizationId",
  // Matter scope is a filter on this read, not a per-entry field.
  "workspaceId",
  // Read only to pick the detail policy that shapes `changes`.
  "metadata",
  // Folded into `actor`, the name a reader recognises.
  "performerName",
  // Agent run, trigger and approval provenance belong to the matter activity
  // feed; the compliance read reports who performed what.
  "performerId",
  "triggerType",
  "triggerUserId",
  "triggerSource",
  "triggerSourceId",
  "runId",
  "groupId",
  "approvalStatus",
  "approvedByUserId",
  "activityCategory",
] as const satisfies readonly (keyof AuditLogRow)[];

// `resource`, `changesStatus`, `actor` and the page cursor are derived, not
// columns.
type AuditLogPageItem = Omit<
  ReturnType<typeof toAuditLogPageItem>,
  "resource" | "changesStatus" | "actor" | "createdAtCursor"
>;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedAuditLogColumn = UnprojectedColumns<
  AuditLogRow,
  AuditLogPageItem,
  (typeof UNPROJECTED_AUDIT_LOG_COLUMNS)[number]
>;
type UnexpectedProjectedAuditLogColumn = UnbackedProjectionKeys<
  AuditLogRow,
  AuditLogPageItem,
  (typeof UNPROJECTED_AUDIT_LOG_COLUMNS)[number]
>;

true satisfies MissingProjectedAuditLogColumn extends never ? true : never;
true satisfies UnexpectedProjectedAuditLogColumn extends never ? true : never;

// Runs the validated compliance-read query. Callers must invoke
// `validateAuditLogFilter` first; this only builds the org-scoped conditions,
// applies the keyset order, and pages the result. Kept transport-agnostic so
// the HTTP handler and the MCP tool return byte-identical pages.
export const queryAuditLogPage = async function* ({
  safeDb,
  organizationId,
  userId,
  featureAccessSnapshot,
  recordAuditEvent,
  query,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
  recordAuditEvent: AuditRecorder;
  query: AuditLogFilter;
}) {
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.auditLogPageSizeDefault,
  );

  const conditions = toAuditLogConditions({ organizationId, filter: query });

  const rows = yield* Result.await(
    safeDb(async (tx) => {
      const auditRows = await tx
        .select({
          id: auditLogs.id,
          createdAt: auditLogs.createdAt,
          userId: auditLogs.userId,
          performerType: auditLogs.performerType,
          performerName: auditLogs.performerName,
          action: auditLogs.action,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          changes: auditReadChangesSql({
            featureAccessSnapshot,
            principal: { organizationId, userId },
          }),
          metadata: auditLogs.metadata,
          // The read projection hides changes it has no policy for, so an
          // unknown kind needs the raw presence to say whether any were withheld.
          hasStoredChanges: auditStoredChangesPresentSql(),
          createdAtCursor: auditLogCursor.cursorValue.as("created_at_cursor"),
        })
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(limit + 1);

      const userIds = [...new Set(auditRows.map((row) => row.userId))];
      const userDetails =
        userIds.length > 0
          ? await tx
              .select({ id: user.id, name: user.name, email: user.email })
              .from(user)
              .innerJoin(member, eq(member.userId, user.id))
              .where(
                and(
                  eq(member.organizationId, organizationId),
                  inArray(user.id, userIds),
                ),
              )
          : [];
      const userMap = new Map(
        userDetails.map((actor) => [
          actor.id,
          actor.name || actor.email || actor.id,
        ]),
      );

      const classifiedRows = auditRows.map((row) => ({
        row,
        resourceKind: classifyAuditResourceKind(row.resourceType),
      }));
      const unknownKindCounts = new Map<string, number>();
      for (const { resourceKind } of classifiedRows) {
        if (resourceKind.type === "unknown") {
          unknownKindCounts.set(
            resourceKind.raw,
            (unknownKindCounts.get(resourceKind.raw) ?? 0) + 1,
          );
        }
      }
      for (const [kind, count] of unknownKindCounts) {
        logger.warn("audit_log.stored_resource_kind_unknown", { kind, count });
      }

      const resourceNames = await resolveAuditResourceNames({
        tx,
        rows: classifiedRows.flatMap(({ row, resourceKind }) =>
          resourceKind.type === "known"
            ? [{ resourceType: resourceKind.kind, resourceId: row.resourceId }]
            : [],
        ),
        organizationId,
        userId,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.ACCESS,
        resourceType: AUDIT_RESOURCE_TYPE.AUDIT_LOG,
        resourceId: ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
      });

      return classifiedRows.map(({ row, resourceKind }) =>
        toAuditLogPageItem({
          row,
          resourceKind,
          resourceNames,
          members: userMap,
          featureAccessSnapshot,
          principal: { organizationId, userId },
        }),
      );
    }),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      auditLogCursor.encode(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    items: page.items.map(
      ({ createdAtCursor: _createdAtCursor, ...item }) => item,
    ),
  });
};
