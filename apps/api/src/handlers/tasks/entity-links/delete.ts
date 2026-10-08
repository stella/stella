import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { resultTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { entityLinks } from "@/api/db/schema";
import { taskRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FLOW_TASK_FEATURE_ACCESS } from "@/api/lib/flows/review-gate-task";
import { admitTaskFlowMutation } from "@/api/lib/flows/review-task-admission";

const deleteEntityLinkBodySchema = t.Object({
  linkId: tSafeId("entityLink"),
});

export type DeleteEntityLinkHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof deleteEntityLinkBodySchema>;
};

// Shared entity-link deletion logic reused by the HTTP handler and the
// `save_task` MCP tool, so both emit identical audit events.
export const deleteEntityLinkHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
}: DeleteEntityLinkHandlerProps) {
  yield* Result.await(
    resultTx(safeDb, async (tx) => {
      const admission = await admitTaskFlowMutation(tx, {
        workspaceId,
        userId,
        target: { type: "link", linkId: body.linkId },
      });
      if (admission.isErr()) {
        return admission;
      }
      const link = await tx.query.entityLinks.findFirst({
        where: {
          id: { eq: body.linkId },
          workspaceId: { eq: workspaceId },
        },
        with: {
          sourceEntity: { columns: { kind: true, readOnly: true } },
          targetEntity: { columns: { kind: true, readOnly: true } },
        },
      });
      if (!link) {
        return Result.err(
          new HandlerError({ status: 404, message: "Link not found" }),
        );
      }
      // Both endpoints are guaranteed by the notNull sourceEntityId/targetEntityId
      // FKs, so a missing relation is a broken invariant, not an expected state.
      const sourceEntity =
        link.sourceEntity ?? panic("Entity link is missing its source entity");
      const targetEntity =
        link.targetEntity ?? panic("Entity link is missing its target entity");
      if (sourceEntity.kind !== "task" && targetEntity.kind !== "task") {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "This endpoint only manages task links",
          }),
        );
      }
      if (
        (sourceEntity.kind === "task" && sourceEntity.readOnly) ||
        (targetEntity.kind === "task" && targetEntity.readOnly)
      ) {
        return Result.err(
          new HandlerError({ status: 409, message: "Task is read-only" }),
        );
      }

      await tx
        .delete(entityLinks)
        .where(
          and(
            eq(entityLinks.id, body.linkId),
            eq(entityLinks.workspaceId, workspaceId),
          ),
        );

      const taskEntityId =
        sourceEntity.kind === "task"
          ? link.sourceEntityId
          : link.targetEntityId;
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: taskEntityId,
        metadata: {
          kind: "task",
          change: "entity-link-removed",
          linkId: body.linkId,
        },
      });
      return Result.ok(undefined);
    }),
  );

  return Result.ok({ success: true });
};

const deleteEntityLink = createSafeHandler(
  {
    description:
      "Remove one link between a task and another document, folder, or task, " +
      "addressed by the link id. Both linked items survive; a link with a task " +
      "on neither end, and a read-only task, are refused.",
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: FLOW_TASK_FEATURE_ACCESS,
    realtime: taskRealtimeUpdates,
    mcp: { type: "covered", by: "save_task" },
    body: deleteEntityLinkBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent, user }) {
    return yield* deleteEntityLinkHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default deleteEntityLink;
