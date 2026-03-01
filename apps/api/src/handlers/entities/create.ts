import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createEntityBodySchema = t.Object({
  kind: t.Optional(entityKindSchema),
  parentId: t.Optional(t.Nullable(tNanoid)),
  name: t.Optional(t.String()),
});

type CreateEntityBodySchema = Static<typeof createEntityBodySchema>;

type CreateEntitiesHandlerProps = {
  workspaceId: SafeId<"workspace">;
  userId: string;
  body: CreateEntityBodySchema;
};

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const checkEntityLimit = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  const totalEntities = await tx.$count(
    entities,
    eq(entities.workspaceId, workspaceId),
  );

  if (totalEntities >= LIMITS.entitiesCount) {
    return Result.err("Entities limit reached");
  }

  return Result.ok({ maxEntitiesCount: LIMITS.entitiesCount - totalEntities });
};

const validateParentId = async (
  tx: Transaction,
  parentId: string,
  workspaceId: SafeId<"workspace">,
) => {
  const parent = await tx.query.entities.findFirst({
    where: {
      id: parentId,
    },
    columns: {
      workspaceId: true,
      kind: true,
    },
  });

  if (!parent) {
    return status(400, {
      message: "Parent entity not found in this workspace",
    });
  }

  if (parent?.workspaceId !== workspaceId) {
    return status(403, {
      message: "Parent entity doesn't belong to this workspace",
    });
  }

  if (parent.kind !== "folder") {
    return status(400, {
      message: "Parent entity must be a folder",
    });
  }

  return null;
};

export const createEntitiesHandler = ({
  workspaceId,
  userId,
  body,
}: CreateEntitiesHandlerProps) => {
  const parentId = body.parentId ?? null;
  const kind = body.kind;
  const name = body.name ?? null;

  return db.transaction(async (tx) => {
    const limitResult = await checkEntityLimit(tx, workspaceId);
    if (Result.isError(limitResult)) {
      return status(400, {
        message: limitResult.error,
      });
    }

    if (parentId) {
      const error = await validateParentId(tx, parentId, workspaceId);
      if (error) {
        return error;
      }
    }

    const entityId = nanoid();

    await tx.insert(entities).values({
      id: entityId,
      workspaceId,
      kind,
      parentId,
      name,
      createdBy: userId,
    });

    const entityVersionId = nanoid();

    await tx.insert(entityVersions).values({ id: entityVersionId, entityId });

    await tx
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));

    await tx
      .update(workspaces)
      .set({ lastActivityAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    return { entityId };
  });
};
