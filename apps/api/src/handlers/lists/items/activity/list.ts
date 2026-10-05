import { Result } from "better-result";
import { and, desc, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedAuditLogId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = workspaceParams({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
});
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.legalListActivityPageSizeMax }),
  ),
  cursor: t.Optional(tPaginationCursor()),
});
const config = {
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "Read one list item's activity trail, newest first with cursor " +
    "pagination: the audit entries recorded against the item and against the " +
    "task behind it, each with its action, the actor's name, the recorded " +
    "changes, and the operation label.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: paramsSchema,
  query: querySchema,
} satisfies WorkspaceHandlerConfig;

const activityCursor = createTimestampIdCursorCodec({
  column: auditLogs.createdAt,
  brandId: brandPersistedAuditLogId,
});

const readItemActivity = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.legalListActivityPageSizeDefault,
    );
    const cursor = query.cursor ? activityCursor.decode(query.cursor) : null;
    if (query.cursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

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

        const cursorCondition = cursor
          ? activityCursor.keysetAfter({
              cursor,
              idColumn: auditLogs.id,
              direction: "descending",
            })
          : undefined;
        return await tx
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            performerName: auditLogs.performerName,
            userName: user.name,
            metadata: auditLogs.metadata,
            changes: auditLogs.changes,
            createdAt: auditLogs.createdAt,
            createdAtCursor: activityCursor.cursorValue.as("created_at_cursor"),
          })
          .from(auditLogs)
          .leftJoin(
            member,
            and(
              eq(member.userId, auditLogs.userId),
              eq(member.organizationId, auditLogs.organizationId),
            ),
          )
          .leftJoin(
            user,
            and(eq(user.id, auditLogs.userId), eq(member.userId, user.id)),
          )
          .where(
            and(
              eq(auditLogs.workspaceId, workspaceId),
              inArray(auditLogs.resourceType, [
                AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
                AUDIT_RESOURCE_TYPE.ENTITY,
              ]),
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

    const page = createCursorPage({
      rows: result,
      limit,
      cursorForItem: (event) =>
        activityCursor.encode(event.createdAtCursor, event.id),
    });
    return Result.ok({
      ...page,
      items: page.items.map((event) => ({
        id: event.id,
        action: event.action,
        actorName: event.performerName ?? event.userName,
        changes: event.changes,
        createdAt: event.createdAt,
        operation:
          typeof event.metadata?.["operation"] === "string"
            ? event.metadata["operation"]
            : null,
      })),
    });
  },
);

export default readItemActivity;
