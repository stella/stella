import { Result } from "better-result";
import { t } from "elysia";

import { entityLinks } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { ENTITY_LINK_TYPES } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

const createEntityLinkBodySchema = t.Object({
  sourceEntityId: tSafeId("entity"),
  targetEntityId: tSafeId("entity"),
  linkType: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

const createEntityLink = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    body: createEntityLinkBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent }) {
    const linkType = body.linkType ?? "related";
    if (!includes(ENTITY_LINK_TYPES, linkType)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid link type" }),
      );
    }

    if (body.sourceEntityId === body.targetEntityId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot link an entity to itself",
        }),
      );
    }

    const [sourceEntity, targetEntity] = yield* Result.await(
      safeDb(
        async (tx) =>
          await Promise.all([
            tx.query.entities.findFirst({
              where: {
                id: { eq: body.sourceEntityId },
                workspaceId: { eq: workspaceId },
              },
              columns: { id: true, kind: true, readOnly: true },
            }),
            tx.query.entities.findFirst({
              where: {
                id: { eq: body.targetEntityId },
                workspaceId: { eq: workspaceId },
              },
              columns: { id: true, kind: true, readOnly: true },
            }),
          ]),
      ),
    );

    if (!sourceEntity || !targetEntity) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "One or both entities not found in this workspace",
        }),
      );
    }

    if (sourceEntity.kind !== "task" && targetEntity.kind !== "task") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "At least one entity must be a task",
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

    const inverseLink = yield* Result.await(
      safeDb((tx) =>
        tx.query.entityLinks.findFirst({
          where: {
            workspaceId: { eq: workspaceId },
            sourceEntityId: { eq: body.targetEntityId },
            targetEntityId: { eq: body.sourceEntityId },
          },
          columns: { id: true },
        }),
      ),
    );
    if (inverseLink) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A link between these entities already exists",
        }),
      );
    }

    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .insert(entityLinks)
          .values({
            workspaceId,
            sourceEntityId: body.sourceEntityId,
            targetEntityId: body.targetEntityId,
            linkType,
          })
          .onConflictDoNothing()
          .returning({ id: entityLinks.id });

        if (rows.length > 0) {
          const taskEntityId =
            sourceEntity.kind === "task"
              ? body.sourceEntityId
              : body.targetEntityId;
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: taskEntityId,
            metadata: {
              change: "entity-link-added",
              linkType,
              sourceEntityId: body.sourceEntityId,
              targetEntityId: body.targetEntityId,
            },
          });
        }

        return rows;
      }),
    );

    if (inserted.length === 0) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A link between these entities already exists",
        }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default createEntityLink;
