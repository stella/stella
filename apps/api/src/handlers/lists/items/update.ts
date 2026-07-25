import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { legalListItems } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
  sectionId: t.Optional(t.Nullable(tSafeId("legalListSection"))),
  position: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  description: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});
const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const updateItem = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        if (body.sectionId) {
          const section = await tx.query.legalListSections.findFirst({
            where: {
              id: { eq: body.sectionId },
              listId: { eq: body.listId },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
          });
          if (!section) {
            return false;
          }
        }
        const updates = pickDefined(body, [
          "sectionId",
          "position",
          "description",
        ]);
        const row = await tx
          .update(legalListItems)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            and(
              eq(legalListItems.entityId, body.itemEntityId),
              eq(legalListItems.listId, body.listId),
              eq(legalListItems.workspaceId, workspaceId),
            ),
          )
          .returning({ id: legalListItems.entityId });
        if (!row.at(0)) {
          return false;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: body.itemEntityId,
          metadata: { operation: "list_item_updated" },
        });
        return true;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "List item or section not found",
        }),
      );
    }
    return Result.ok({ id: body.itemEntityId });
  },
);

export default updateItem;
