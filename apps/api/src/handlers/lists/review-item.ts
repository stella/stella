import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  LEGAL_LIST_REVIEW_DECISIONS,
  legalListItemReviews,
  legalListItems,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
  decision: t.String({ minLength: 1, maxLength: 32 }),
  note: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});
const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const reviewItem = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    if (!includes(LEGAL_LIST_REVIEW_DECISIONS, body.decision)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid review decision" }),
      );
    }
    const decision = body.decision;
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const updated = await tx
          .update(legalListItems)
          .set({ reviewStatus: decision, updatedAt: new Date() })
          .where(
            and(
              eq(legalListItems.entityId, body.itemEntityId),
              eq(legalListItems.listId, body.listId),
              eq(legalListItems.workspaceId, workspaceId),
            ),
          )
          .returning({ entityId: legalListItems.entityId });
        if (!updated.at(0)) {
          return null;
        }
        const reviewId = createSafeId<"legalListItemReview">();
        await tx.insert(legalListItemReviews).values({
          id: reviewId,
          workspaceId,
          listId: body.listId,
          itemEntityId: body.itemEntityId,
          decision,
          note: body.note ?? null,
          reviewerId: user.id,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: body.itemEntityId,
          metadata: { operation: "review_recorded", reviewId, decision },
        });
        return reviewId;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List item not found" }),
      );
    }
    return Result.ok({ id: result });
  },
);

export default reviewItem;
