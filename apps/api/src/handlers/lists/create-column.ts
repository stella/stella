import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { legalListColumns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  propertyId: tSafeId("property"),
  position: t.Optional(t.Integer({ minimum: 0 })),
  required: t.Optional(t.Boolean()),
});
const config = {
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const createColumn = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const [list, property, count] = await Promise.all([
          tx.query.legalLists.findFirst({
            where: {
              id: { eq: body.listId },
              workspaceId: { eq: workspaceId },
              status: { eq: "active" },
            },
            columns: { id: true },
          }),
          tx.query.properties.findFirst({
            where: {
              id: { eq: body.propertyId },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
          }),
          tx.$count(
            legalListColumns,
            and(
              eq(legalListColumns.workspaceId, workspaceId),
              eq(legalListColumns.listId, body.listId),
            ),
          ),
        ]);
        if (!list || !property) {
          return { status: "missing" as const };
        }
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
            : { status: "limit" as const };
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
        new HandlerError({ status: 400, message: "List column limit reached" }),
      );
    }
    return Result.ok({ id: result.id });
  },
);

export default createColumn;
