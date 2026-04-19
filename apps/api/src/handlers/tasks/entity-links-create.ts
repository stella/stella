import { Result } from "better-result";
import { t } from "elysia";

import { entityLinks } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { ENTITY_LINK_TYPES } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

const createEntityLinkBodySchema = t.Object({
  sourceEntityId: tNanoid,
  targetEntityId: tNanoid,
  linkType: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

const createEntityLink = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    body: createEntityLinkBodySchema,
  },
  async function* ({ workspaceId, body, safeDb }) {
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
                id: body.sourceEntityId,
                workspaceId: { eq: workspaceId },
              },
              columns: { id: true, kind: true },
            }),
            tx.query.entities.findFirst({
              where: {
                id: body.targetEntityId,
                workspaceId: { eq: workspaceId },
              },
              columns: { id: true, kind: true },
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

    const inverseLink = yield* Result.await(
      safeDb((tx) =>
        tx.query.entityLinks.findFirst({
          where: {
            workspaceId: { eq: workspaceId },
            sourceEntityId: body.targetEntityId,
            targetEntityId: body.sourceEntityId,
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
      safeDb((tx) =>
        tx
          .insert(entityLinks)
          .values({
            workspaceId,
            sourceEntityId: body.sourceEntityId,
            targetEntityId: body.targetEntityId,
            linkType,
          })
          .onConflictDoNothing()
          .returning({ id: entityLinks.id }),
      ),
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
