import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  LEGAL_LIST_SOURCE_VERIFICATION_STATUSES,
  legalListItemSources,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

const bodySchema = t.Object({
  id: tSafeId("legalListItemSource"),
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
  status: t.String({ minLength: 1, maxLength: 32 }),
});
const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const verifyItemSource = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const verificationStatus = body.status;
    if (
      !includes(LEGAL_LIST_SOURCE_VERIFICATION_STATUSES, verificationStatus)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid verification status",
        }),
      );
    }
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const updated = await tx
          .update(legalListItemSources)
          .set({
            verificationStatus,
            verifiedBy: verificationStatus === "unverified" ? null : user.id,
            verifiedAt: verificationStatus === "unverified" ? null : new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(legalListItemSources.id, body.id),
              eq(legalListItemSources.workspaceId, workspaceId),
              eq(legalListItemSources.listId, body.listId),
              eq(legalListItemSources.itemEntityId, body.itemEntityId),
            ),
          )
          .returning({ id: legalListItemSources.id });
        if (!updated.at(0)) {
          return false;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: body.itemEntityId,
          metadata: {
            operation: "source_verification_changed",
            sourceId: body.id,
            status: verificationStatus,
          },
        });
        return true;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "List item source not found",
        }),
      );
    }
    return Result.ok({ id: body.id });
  },
);

export default verifyItemSource;
