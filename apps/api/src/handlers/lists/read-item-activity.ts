import { Result } from "better-result";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { t } from "elysia";

import { auditLogs } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedAuditLogId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = t.Object({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
});
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.legalListActivityPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});
const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: paramsSchema,
  query: querySchema,
} satisfies HandlerConfig;

const readItemActivity = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    const limit = query.limit ?? LIMITS.legalListActivityPageSizeDefault;
    const cursorParts = query.cursor
      ? decodePaginationCursor(query.cursor)
      : null;
    const cursorDate = cursorParts
      ? parseDateTimePaginationCursorPart(cursorParts.at(0))
      : null;
    const cursorId = cursorParts?.at(1);
    if (
      query.cursor &&
      (!cursorDate || !isUuidPaginationCursorPart(cursorId))
    ) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursorAuditId =
      typeof cursorId === "string" && isUuidPaginationCursorPart(cursorId)
        ? brandPersistedAuditLogId(cursorId)
        : null;

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const item = await tx.query.legalListItems.findFirst({
          where: {
            entityId: { eq: params.itemEntityId },
            listId: { eq: params.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { entityId: true },
        });
        if (!item) {
          return null;
        }

        const cursorCondition =
          cursorDate && cursorAuditId
            ? or(
                lt(auditLogs.createdAt, cursorDate),
                and(
                  eq(auditLogs.createdAt, cursorDate),
                  lt(auditLogs.id, cursorAuditId),
                ),
              )
            : undefined;
        return await tx
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            userId: auditLogs.userId,
            metadata: auditLogs.metadata,
            changes: auditLogs.changes,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.workspaceId, workspaceId),
              eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM),
              eq(auditLogs.resourceId, params.itemEntityId),
              cursorCondition,
            ),
          )
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(limit + 1);
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List item not found" }),
      );
    }

    return Result.ok(
      createCursorPage({
        rows: result.map((event) => ({
          id: event.id,
          action: event.action,
          userId: event.userId,
          changes: event.changes,
          createdAt: event.createdAt,
          operation:
            typeof event.metadata?.["operation"] === "string"
              ? event.metadata["operation"]
              : null,
        })),
        limit,
        cursorForItem: (event) =>
          encodePaginationCursor([event.createdAt.toISOString(), event.id]),
      }),
    );
  },
);

export default readItemActivity;
