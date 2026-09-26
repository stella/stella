import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const bodySchema = t.Object({ matterId: tSafeId("workspace") });
const paramsSchema = t.Object({
  senderId: tSafeId("correspondenceAllowedSender"),
});
const config = {
  description: "Remove one matter from a shared mailbox sender's filing scope.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "correspondence" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

const removeAllowedSenderMatter = createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const senderRows = await tx
          .select({ id: correspondenceAllowedSenders.id })
          .from(correspondenceAllowedSenders)
          .where(
            and(
              eq(correspondenceAllowedSenders.id, params.senderId),
              eq(
                correspondenceAllowedSenders.organizationId,
                session.activeOrganizationId,
              ),
              eq(correspondenceAllowedSenders.kind, "shared_mailbox"),
            ),
          )
          .for("update");
        const sender = senderRows.at(0);
        if (!sender) return { kind: "missing_sender" as const };

        const removed = await tx
          .delete(correspondenceAllowedSenderMatters)
          .where(
            and(
              eq(
                correspondenceAllowedSenderMatters.organizationId,
                session.activeOrganizationId,
              ),
              eq(correspondenceAllowedSenderMatters.allowedSenderId, sender.id),
              eq(correspondenceAllowedSenderMatters.workspaceId, body.matterId),
            ),
          )
          .returning({ id: correspondenceAllowedSenderMatters.id });
        if (removed.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: session.activeOrganizationId,
            metadata: {
              field: "correspondenceAllowedSenderScope",
              allowedSenderId: sender.id,
              removedMatterId: body.matterId,
            },
          });
        }
        return { kind: "removed" as const };
      }),
    );

    if (result.kind === "missing_sender")
      return Result.err(
        new HandlerError({ status: 404, message: "Allowed sender not found" }),
      );
    return Result.ok({ removed: true });
  },
);

export default removeAllowedSenderMatter;
