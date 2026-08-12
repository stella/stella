import { Result } from "better-result";
import { t } from "elysia";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import type { ResourceRef } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { entityLinks } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { ENTITY_LINK_TYPES } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

const createEntityLinkBodySchema = t.Object({
  sourceEntityId: tSafeId("entity"),
  targetEntityId: tSafeId("entity"),
  linkType: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

export type CreateEntityLinkHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: {
    source: ResourceRef<"entity">;
    target: ResourceRef<"entity">;
    linkType?: string | undefined;
  };
};

// Shared entity-link creation logic reused by the HTTP handler and the
// `save_task` MCP tool, so both emit identical audit events.
export const createEntityLinkHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
  body,
}: CreateEntityLinkHandlerProps) {
  const sourceEntityId = body.source.id;
  const targetEntityId = body.target.id;
  const linkType = body.linkType ?? "related";
  if (!includes(ENTITY_LINK_TYPES, linkType)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid link type" }),
    );
  }

  if (sourceEntityId === targetEntityId) {
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
              id: { eq: sourceEntityId },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true, kind: true, readOnly: true },
          }),
          tx.query.entities.findFirst({
            where: {
              id: { eq: targetEntityId },
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
          sourceEntityId: { eq: targetEntityId },
          targetEntityId: { eq: sourceEntityId },
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
          sourceEntityId,
          targetEntityId,
          linkType,
        })
        .onConflictDoNothing()
        .returning({ id: entityLinks.id });

      if (rows.length > 0) {
        const taskEntityId =
          sourceEntity.kind === "task" ? sourceEntityId : targetEntityId;
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: taskEntityId,
          metadata: {
            kind: "task",
            change: "entity-link-added",
            linkType,
            sourceEntityId,
            targetEntityId,
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
};

const createEntityLink = createSafeHandler(
  {
    description:
      "Link a task to another document, folder, or task, with a link type " +
      "that defaults to related. Both ends must be in this matter, an entity " +
      "cannot be linked to itself, and a read-only entity is refused. Remove " +
      "the link with tasks.entity-links-delete.",
    permissions: { entity: ["update"] },
    mcp: { type: "covered", by: "save_task" },
    body: createEntityLinkBodySchema,
  },
  async function* ({ workspaceId, body, safeDb, recordAuditEvent }) {
    return yield* createEntityLinkHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body: {
        source: resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: body.sourceEntityId,
        }),
        target: resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: body.targetEntityId,
        }),
        ...(body.linkType === undefined ? {} : { linkType: body.linkType }),
      },
    });
  },
);

export default createEntityLink;
