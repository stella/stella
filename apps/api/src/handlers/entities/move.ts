import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const moveEntityBodySchema = t.Object({
  entityId: tNanoid,
  parentId: t.Nullable(tNanoid),
});

type MoveEntityBodySchema = Static<typeof moveEntityBodySchema>;

type MoveEntityHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: MoveEntityBodySchema;
};

export const moveEntityHandler = ({
  workspaceId,
  body,
}: MoveEntityHandlerProps) => {
  return db.transaction(async (tx) => {
    // Lock the entity row to prevent concurrent moves.
    const [entity] = await tx
      .select({ id: entities.id, kind: entities.kind })
      .from(entities)
      .where(
        and(
          eq(entities.id, body.entityId),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .for("update");

    if (!entity) {
      return status(404, { message: "Entity not found" });
    }

    if (body.parentId === null) {
      await tx
        .update(entities)
        .set({ parentId: null, updatedAt: new Date() })
        .where(eq(entities.id, body.entityId));
      return status(200);
    }

    // Prevent moving to itself.
    if (body.entityId === body.parentId) {
      return status(400, {
        message: "Cannot move an entity into itself",
      });
    }

    // Lock and verify the target parent is a folder
    // in the same workspace.
    const [parent] = await tx
      .select({ id: entities.id, kind: entities.kind })
      .from(entities)
      .where(
        and(
          eq(entities.id, body.parentId),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .for("update");

    if (!parent) {
      return status(400, {
        message: "Parent entity not found in this workspace",
      });
    }

    if (parent.kind !== "folder") {
      return status(400, {
        message: "Parent entity must be a folder",
      });
    }

    // If the entity being moved is a folder, prevent cycles
    // by checking that the target parent is not a descendant.
    if (entity.kind === "folder") {
      const isDescendant = await checkIsDescendant(
        tx,
        body.parentId,
        body.entityId,
        workspaceId,
      );

      if (isDescendant) {
        return status(400, {
          message: "Cannot move a folder into one of its descendants",
        });
      }
    }

    await tx
      .update(entities)
      .set({ parentId: body.parentId, updatedAt: new Date() })
      .where(eq(entities.id, body.entityId));

    return status(200);
  });
};

/**
 * Walk up the parent chain from `startId` to see if we ever
 * reach `targetAncestorId`. Returns true if the start is a
 * descendant of the target.
 *
 * Reads within the provided transaction to see locked rows.
 */
const checkIsDescendant = async (
  tx: Transaction,
  startId: string,
  targetAncestorId: string,
  workspaceId: SafeId<"workspace">,
): Promise<boolean> => {
  let currentId: string | null = startId;

  // Bounded loop to prevent infinite iteration in case of
  // data corruption. 100 levels of nesting is far beyond
  // any real usage.
  for (let i = 0; i < 100 && currentId; i++) {
    if (currentId === targetAncestorId) {
      return true;
    }

    const current: { parentId: string | null } | undefined =
      await tx.query.entities.findFirst({
        where: {
          id: currentId,
          workspaceId,
        },
        columns: {
          parentId: true,
        },
      });

    currentId = current?.parentId ?? null;
  }

  return false;
};
