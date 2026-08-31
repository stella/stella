import { Result } from "better-result";
import { t } from "elysia";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import { legalListItemComments } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { detached } from "@/api/lib/detached";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  fanOutNotifications,
  resolveMentionTargets,
} from "@/api/lib/notifications";
import type { NewNotification } from "@/api/lib/notifications";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
  body: t.String({ minLength: 1, maxLength: 10_000 }),
});
const config = {
  description:
    "Add a comment to one list item. The comment is stored against the item " +
    "and shows up in its activity trail.",
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const createItemComment = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    user,
    body,
    recordAuditEvent,
    session,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const item = await tx.query.legalListItems.findFirst({
          where: {
            entityId: { eq: body.itemEntityId },
            listId: { eq: body.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { entityId: true },
        });
        if (!item) {
          return null;
        }
        const id = createSafeId<"legalListItemComment">();
        await tx.insert(legalListItemComments).values({
          id,
          workspaceId,
          listId: body.listId,
          itemEntityId: body.itemEntityId,
          body: body.body,
          authorId: user.id,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: body.itemEntityId,
          metadata: { operation: "comment_added", commentId: id },
        });
        // Resolved inside the request's transaction and under the caller's
        // RLS scope, so a mention can only ever name somebody who is already
        // a member of this server-validated workspace.
        const mentions = await resolveMentionTargets(tx, {
          actorUserId: user.id,
          text: body.body,
          workspaceId,
        });
        return { id, mentions };
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List item not found" }),
      );
    }

    if (result.mentions.userIds.length > 0) {
      const rows = result.mentions.userIds.map(
        (mentioned): NewNotification => ({
          kind: NOTIFICATION_KIND.MENTION,
          metadata: { actorName: result.mentions.actorName },
          entityType: "entity",
          entityId: body.itemEntityId,
          organizationId: session.activeOrganizationId,
          userId: mentioned,
          idempotencyKey: `mention:${result.id}`,
        }),
      );
      // Fanned out after the comment commits, not inside its transaction: a
      // mention names OTHER people, and the user-and-organization RLS scope
      // this handler runs under refuses a row addressed to somebody else, so
      // there is no transaction that can hold both writes. Detached rather
      // than awaited because the comment is already durable and its author
      // must not see the write fail over a colleague's badge — the rejection
      // still reaches error capture rather than being swallowed.
      detached(fanOutNotifications(rows), "notifications.list-item-mention");
    }

    return Result.ok({ id: result.id });
  },
);

export default createItemComment;
