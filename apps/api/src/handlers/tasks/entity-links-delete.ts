import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entityLinks } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteEntityLinkBodySchema = t.Object({
  linkId: tSafeId("entityLink"),
});

export type DeleteEntityLinkHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof deleteEntityLinkBodySchema>;
};

// Shared entity-link deletion logic reused by the HTTP handler and the
// `save_task` MCP tool, so both emit identical audit events.
export const deleteEntityLinkHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
  body,
}: DeleteEntityLinkHandlerProps) {
  const link = yield* Result.await(
    safeDb((tx) =>
      tx.query.entityLinks.findFirst({
        where: {
          id: { eq: body.linkId },
          workspaceId: { eq: workspaceId },
        },
        with: {
          sourceEntity: { columns: { kind: true, readOnly: true } },
          targetEntity: { columns: { kind: true, readOnly: true } },
        },
      }),
    ),
  );
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

  yield* Result.await(
    safeDb(async (tx) => {
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
          change: "entity-link-removed",
          linkId: body.linkId,
        },
      });
    }),
  );

  return Result.ok({ success: true });
};

const deleteEntityLink = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    mcp: { type: "covered", by: "save_task" },
    body: deleteEntityLinkBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent }) {
    return yield* deleteEntityLinkHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default deleteEntityLink;
