import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, inArray, gte, lt, lte, or } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import {
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import type { ParsedPgTimestampCursor } from "@/api/lib/db-pagination";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedAuditLogId } from "@/api/lib/safe-id-boundaries";

const CURSOR_SEPARATOR = "|";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const auditLogCreatedAtCursor = pgTimestampCursorValue(auditLogs.createdAt);

const encodeCursor = (createdAt: string, id: string): string =>
  `${createdAt}${CURSOR_SEPARATOR}${id}`;

const decodeCursor = (
  cursor: string,
): { createdAt: ParsedPgTimestampCursor; id: SafeId<"auditLog"> } | null => {
  const separatorIndex = cursor.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const createdAt = parsePgTimestampCursorValue(
    cursor.slice(0, separatorIndex),
  );
  const id = cursor.slice(separatorIndex + 1);
  if (createdAt === null || !UUID_RE.test(id)) {
    return null;
  }

  return { createdAt, id: brandPersistedAuditLogId(id) };
};

export const readAuditLogsQuerySchema = t.Object({
  workspaceId: t.Optional(tSafeId("workspace")),
  // The shared validator below checks these strings against the domain
  // constants so HTTP and MCP callers reject unknown values identically.
  action: t.Optional(t.String({ minLength: 1 })),
  resourceType: t.Optional(t.String({ minLength: 1 })),
  resourceId: t.Optional(t.String({ minLength: 1 })),
  userId: t.Optional(tUserId),
  from: t.Optional(t.String({ format: "date-time" })),
  to: t.Optional(t.String({ format: "date-time" })),
  toExclusive: t.Optional(t.String({ format: "date-time" })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.auditLogPageSizeMax,
    }),
  ),
  cursor: t.Optional(t.String()),
});

export type ReadAuditLogsQuery = Static<typeof readAuditLogsQuerySchema>;

export const toAuditLogConditions = (query: ReadAuditLogsQuery): SQL[] => {
  const conditions: SQL[] = [];

  /* eslint-disable no-body-ownership-ids/no-body-ownership-ids -- org-scoped compliance filter, not an ownership source */
  if (query.workspaceId) {
    conditions.push(eq(auditLogs.workspaceId, query.workspaceId));
  }
  /* eslint-enable no-body-ownership-ids/no-body-ownership-ids */
  if (query.action) {
    conditions.push(eq(auditLogs.action, query.action));
  }
  if (query.resourceType) {
    conditions.push(eq(auditLogs.resourceType, query.resourceType));
  }
  if (query.resourceId) {
    conditions.push(eq(auditLogs.resourceId, query.resourceId));
  }
  if (query.userId) {
    conditions.push(eq(auditLogs.userId, query.userId));
  }
  if (query.from) {
    conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
  }
  if (query.to) {
    conditions.push(lte(auditLogs.createdAt, new Date(query.to)));
  }
  if (query.toExclusive) {
    conditions.push(lt(auditLogs.createdAt, new Date(query.toExclusive)));
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) {
      return conditions;
    }

    const cursorCondition = or(
      lt(auditLogs.createdAt, pgTimestampCursorBoundary(cursor.createdAt)),
      and(
        eq(auditLogs.createdAt, pgTimestampCursorBoundary(cursor.createdAt)),
        lt(auditLogs.id, cursor.id),
      ),
    );
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
  if (query.cursor && !decodeCursor(query.cursor)) {
    return "Invalid cursor";
  }
  return null;
};

// Runs the validated compliance-read query. Callers must invoke
// `validateAuditLogFilter` first; this only builds the org-scoped conditions,
// applies the keyset order, and pages the result. Kept transport-agnostic so
// the HTTP handler and the MCP tool return byte-identical pages.
export const queryAuditLogPage = async function* ({
  safeDb,
  organizationId,
  recordAuditEvent,
  query,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  query: AuditLogFilter;
}) {
  const limit = query.limit ?? LIMITS.auditLogPageSizeDefault;

  const conditions = [
    eq(auditLogs.organizationId, organizationId),
    ...toAuditLogConditions(query),
  ];

  const rows = yield* Result.await(
    safeDb(async (tx) => {
      const auditRows = await tx
        .select({
          id: auditLogs.id,
          createdAt: auditLogs.createdAt,
          userId: auditLogs.userId,
          action: auditLogs.action,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          changes: auditLogs.changes,
          createdAtCursor: auditLogCreatedAtCursor.as("created_at_cursor"),
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

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.ACCESS,
        resourceType: AUDIT_RESOURCE_TYPE.AUDIT_LOG,
        resourceId: ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
      });

      const rowsWithActors = [];
      for (const row of auditRows) {
        rowsWithActors.push({
          id: row.id,
          createdAt: row.createdAt,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          changes: row.changes,
          createdAtCursor: row.createdAtCursor,
          userId: row.userId,
          actor: userMap.get(row.userId) ?? row.userId,
        });
      }
      return rowsWithActors;
    }),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodeCursor(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    items: page.items.map(
      ({ createdAtCursor: _createdAtCursor, ...item }) => item,
    ),
  });
};
