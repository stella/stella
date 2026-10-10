import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { legalListColumns, legalLists } from "@/api/db/schema";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import { LIST_COLUMN_LIMIT_ERROR_CODE } from "@/api/lib/lists/column-error-codes";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  propertyId: tSafeId("property"),
  position: t.Optional(t.Integer({ minimum: 0 })),
  required: t.Optional(t.Boolean()),
});
const config = {
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "Add a column to a list by binding one of the matter's properties to it, " +
    "with an optional position and a required flag. The list must be active " +
    "and the property must belong to the same matter. A property can be " +
    "bound only once per list: binding it again returns the existing column " +
    "rather than creating a second one, except once the list holds its " +
    "maximum number of columns, where the cap is checked first and the call " +
    "is refused.",
  permissions: { view: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: legalListRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const createColumn = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const lists = await tx
          .select({ id: legalLists.id })
          .from(legalLists)
          .where(
            and(
              eq(legalLists.id, body.listId),
              eq(legalLists.workspaceId, workspaceId),
              eq(legalLists.status, "active"),
            ),
          )
          .for("update");
        const list = lists.at(0);
        const property = await tx.query.properties.findFirst({
          where: {
            id: { eq: body.propertyId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        });
        if (!list || !property) {
          return { status: "missing" as const };
        }
        const count = await tx.$count(
          legalListColumns,
          and(
            eq(legalListColumns.workspaceId, workspaceId),
            eq(legalListColumns.listId, body.listId),
          ),
        );
        if (count >= LIMITS.legalListColumnsPerList) {
          return { status: "limit" as const };
        }
        const id = createSafeId<"legalListColumn">();
        const inserted = await tx
          .insert(legalListColumns)
          .values({
            id,
            workspaceId,
            listId: body.listId,
            propertyId: body.propertyId,
            position: body.position ?? count,
            required: body.required ?? false,
          })
          .onConflictDoNothing({
            target: [legalListColumns.listId, legalListColumns.propertyId],
          })
          .returning({ id: legalListColumns.id });
        const insertedColumn = inserted.at(0);
        if (!insertedColumn) {
          const existing = await tx.query.legalListColumns.findFirst({
            where: {
              workspaceId: { eq: workspaceId },
              listId: { eq: body.listId },
              propertyId: { eq: body.propertyId },
            },
            columns: { id: true },
          });
          return existing
            ? { status: "created" as const, id: existing.id }
            : { status: "internal" as const };
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
          resourceId: body.listId,
          metadata: { operation: "column_added", columnId: id },
        });
        return { status: "created" as const, id: insertedColumn.id };
      }),
    );
    if (result.status === "missing") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "List or property not found",
        }),
      );
    }
    if (result.status === "limit") {
      return Result.err(
        new HandlerError({
          status: 400,
          code: LIST_COLUMN_LIMIT_ERROR_CODE,
          message: "List column limit reached",
          hint: "Use the existing columns or call lists.create to create another list.",
        }),
      );
    }
    if (result.status === "internal") {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "List column conflict could not be resolved",
        }),
      );
    }
    return Result.ok({ id: result.id });
  },
);

export default createColumn;
