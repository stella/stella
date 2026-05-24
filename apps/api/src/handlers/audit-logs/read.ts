import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { auditLogs } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedAuditLogId } from "@/api/lib/safe-id-boundaries";

const CURSOR_SEPARATOR = "|";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const encodeCursor = (createdAt: Date, id: string): string =>
  `${createdAt.toISOString()}${CURSOR_SEPARATOR}${id}`;

const decodeCursor = (
  cursor: string,
): { createdAt: Date; id: SafeId<"auditLog"> } | null => {
  const separatorIndex = cursor.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const createdAt = new Date(cursor.slice(0, separatorIndex));
  const id = cursor.slice(separatorIndex + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(id)) {
    return null;
  }

  return { createdAt, id: brandPersistedAuditLogId(id) };
};

const readAuditLogsQuerySchema = t.Object({
  workspaceId: t.Optional(tSafeId("workspace")),
  // Use literal unions so a typo'd filter fails as 400 at the boundary
  // instead of returning an empty page. Adding a new action or
  // resource type to AUDIT_ACTION / AUDIT_RESOURCE_TYPE automatically
  // widens this union via the const-object Object.values inference.
  action: t.Optional(t.String({ minLength: 1 })),
  resourceType: t.Optional(t.String({ minLength: 1 })),
  resourceId: t.Optional(t.String({ minLength: 1 })),
  userId: t.Optional(tUserId),
  from: t.Optional(t.String({ format: "date-time" })),
  to: t.Optional(t.String({ format: "date-time" })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.auditLogPageSizeMax,
    }),
  ),
  cursor: t.Optional(t.String()),
});

type ReadAuditLogsQuery = Static<typeof readAuditLogsQuerySchema>;

const toAuditLogConditions = (query: ReadAuditLogsQuery): SQL[] => {
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
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) {
      return conditions;
    }

    const cursorCondition = or(
      lt(auditLogs.createdAt, cursor.createdAt),
      and(
        eq(auditLogs.createdAt, cursor.createdAt),
        lt(auditLogs.id, cursor.id),
      ),
    );
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  return conditions;
};

const config = {
  permissions: { auditLog: ["read"] },
  query: readAuditLogsQuerySchema,
} satisfies HandlerConfig;

const VALID_ACTIONS = new Set<string>(Object.values(AUDIT_ACTION));
const VALID_RESOURCE_TYPES = new Set<string>(
  Object.values(AUDIT_RESOURCE_TYPE),
);

const readAuditLogs = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    const limit = query.limit ?? LIMITS.auditLogPageSizeDefault;

    if (query.action !== undefined && !VALID_ACTIONS.has(query.action)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Unknown action filter '${query.action}'`,
        }),
      );
    }

    if (
      query.resourceType !== undefined &&
      !VALID_RESOURCE_TYPES.has(query.resourceType)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Unknown resourceType filter '${query.resourceType}'`,
        }),
      );
    }

    if (query.resourceId && !query.resourceType) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "resourceType is required when resourceId is provided",
        }),
      );
    }

    if (query.cursor && !decodeCursor(query.cursor)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const conditions = [
      eq(auditLogs.organizationId, session.activeOrganizationId),
      ...toAuditLogConditions(query),
    ];

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(auditLogs)
          .where(and(...conditions))
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(limit + 1),
      ),
    );

    return Result.ok(
      createCursorPage({
        rows,
        limit,
        cursorForItem: (item) => encodeCursor(item.createdAt, item.id),
      }),
    );
  },
);

export default readAuditLogs;
