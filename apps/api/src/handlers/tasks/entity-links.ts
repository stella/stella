import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entityLinks } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { ENTITY_LINK_TYPES } from "@/api/lib/entity-constants";

export const createEntityLinkBodySchema = t.Object({
  sourceEntityId: tNanoid,
  targetEntityId: tNanoid,
  linkType: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

type CreateEntityLinkBody = Static<typeof createEntityLinkBodySchema>;

export const deleteEntityLinkBodySchema = t.Object({
  linkId: tNanoid,
});

type DeleteEntityLinkBody = Static<typeof deleteEntityLinkBodySchema>;

type EntityLinkProps<T> = {
  workspaceId: SafeId<"workspace">;
  body: T;
  scopedDb: ScopedDb;
};

type ListEntityLinksProps = {
  workspaceId: SafeId<"workspace">;
  entityId: string;
  scopedDb: ScopedDb;
};

export const createEntityLinkHandler = async ({
  workspaceId,
  body,
  scopedDb,
}: EntityLinkProps<CreateEntityLinkBody>) => {
  const linkType = body.linkType ?? "related";
  if (!(ENTITY_LINK_TYPES as readonly string[]).includes(linkType)) {
    return status(400, { message: "Invalid link type" });
  }

  if (body.sourceEntityId === body.targetEntityId) {
    return status(400, {
      message: "Cannot link an entity to itself",
    });
  }

  const [sourceEntity, targetEntity] = await scopedDb(
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
  );

  if (!sourceEntity || !targetEntity) {
    return status(404, {
      message: "One or both entities not found in this workspace",
    });
  }

  if (sourceEntity.kind !== "task" && targetEntity.kind !== "task") {
    return status(400, {
      message: "At least one entity must be a task",
    });
  }

  // Check if the inverse link already exists
  const inverseLink = await scopedDb((tx) =>
    tx.query.entityLinks.findFirst({
      where: {
        workspaceId: { eq: workspaceId },
        sourceEntityId: body.targetEntityId,
        targetEntityId: body.sourceEntityId,
      },
      columns: { id: true },
    }),
  );
  if (inverseLink) {
    return status(409, {
      message: "A link between these entities already exists",
    });
  }

  const inserted = await scopedDb((tx) =>
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
  );

  if (inserted.length === 0) {
    return status(409, {
      message: "A link between these entities already exists",
    });
  }

  return { success: true };
};

export const deleteEntityLinkHandler = async ({
  workspaceId,
  body,
  scopedDb,
}: EntityLinkProps<DeleteEntityLinkBody>) => {
  // Verify the link exists and involves at least one task
  const link = await scopedDb((tx) =>
    tx.query.entityLinks.findFirst({
      where: {
        id: body.linkId,
        workspaceId: { eq: workspaceId },
      },
      with: {
        sourceEntity: { columns: { kind: true } },
        targetEntity: { columns: { kind: true } },
      },
    }),
  );
  if (!link) {
    return status(404, { message: "Link not found" });
  }
  if (
    link.sourceEntity?.kind !== "task" &&
    link.targetEntity?.kind !== "task"
  ) {
    return status(400, {
      message: "This endpoint only manages task links",
    });
  }

  await scopedDb((tx) =>
    tx
      .delete(entityLinks)
      .where(
        and(
          eq(entityLinks.id, body.linkId),
          eq(entityLinks.workspaceId, workspaceId),
        ),
      ),
  );

  return { success: true };
};

export const listEntityLinksHandler = async ({
  workspaceId,
  entityId,
  scopedDb,
}: ListEntityLinksProps) => {
  const entity = await scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: entityId,
        workspaceId: { eq: workspaceId },
        kind: "task",
      },
      columns: { id: true },
    }),
  );
  if (!entity) {
    return status(404, { message: "Task not found" });
  }

  const [asSource, asTarget] = await scopedDb(
    async (tx) =>
      await Promise.all([
        tx.query.entityLinks.findMany({
          where: {
            workspaceId: { eq: workspaceId },
            sourceEntityId: entityId,
          },
          with: {
            sourceEntity: {
              columns: { id: true, name: true, kind: true },
            },
            targetEntity: {
              columns: { id: true, name: true, kind: true },
            },
          },
          limit: 200,
        }),
        tx.query.entityLinks.findMany({
          where: {
            workspaceId: { eq: workspaceId },
            targetEntityId: entityId,
          },
          with: {
            sourceEntity: {
              columns: { id: true, name: true, kind: true },
            },
            targetEntity: {
              columns: { id: true, name: true, kind: true },
            },
          },
          limit: 200,
        }),
      ]),
  );

  return [...asSource, ...asTarget];
};
