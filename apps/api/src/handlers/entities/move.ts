import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { entities, workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const moveEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  parentId: t.Nullable(tSafeId("entity")),
});

type MoveEntityBodySchema = Static<typeof moveEntityBodySchema>;

type MoveEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  body: MoveEntityBodySchema;
};

const moveEntityHandler = async function* ({
  safeDb,
  workspaceId,
  body,
}: MoveEntityHandlerProps) {
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      // Lock the entity row to prevent concurrent moves.
      const entityRows = await tx
        .select({ id: entities.id, kind: entities.kind })
        .from(entities)
        .where(
          and(
            eq(entities.id, body.entityId),
            eq(entities.workspaceId, workspaceId),
          ),
        )
        .for("update");
      const entity = entityRows.at(0);

      if (!entity) {
        return {
          ok: false as const,
          status: 404 as const,
          message: "Entity not found",
        };
      }

      if (body.parentId === null) {
        await tx
          .update(entities)
          .set({ parentId: null, updatedAt: new Date() })
          .where(eq(entities.id, body.entityId));
        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));
        return { ok: true as const };
      }

      // Prevent moving to itself.
      if (body.entityId === body.parentId) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Cannot move an entity into itself",
        };
      }

      // Lock and verify the target parent is a folder
      // in the same workspace.
      const parentRows = await tx
        .select({ id: entities.id, kind: entities.kind })
        .from(entities)
        .where(
          and(
            eq(entities.id, body.parentId),
            eq(entities.workspaceId, workspaceId),
          ),
        )
        .for("update");
      const parent = parentRows.at(0);

      if (!parent) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Parent entity not found in this workspace",
        };
      }

      if (parent.kind !== "folder") {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Parent entity must be a folder",
        };
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
          return {
            ok: false as const,
            status: 400 as const,
            message: "Cannot move a folder into one of its descendants",
          };
        }
      }

      await tx
        .update(entities)
        .set({ parentId: body.parentId, updatedAt: new Date() })
        .where(eq(entities.id, body.entityId));

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      return { ok: true as const };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  return Result.ok(undefined);
};

/**
 * Walk up the parent chain from `startId` using a recursive
 * CTE (single query) to check if `targetAncestorId` is an
 * ancestor. Returns true if the start is a descendant of the
 * target.
 *
 * The CTE is bounded to 100 levels to guard against data
 * corruption (circular parent references).
 */
const checkIsDescendant = async (
  tx: Transaction,
  startId: SafeId<"entity">,
  targetAncestorId: SafeId<"entity">,
  workspaceId: SafeId<"workspace">,
): Promise<boolean> => {
  const result = await tx.execute<{ found: boolean }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT ${entities.id}, ${entities.parentId}, 1 AS depth
      FROM ${entities}
      WHERE ${entities.id} = ${startId}
        AND ${entities.workspaceId} = ${workspaceId}
      UNION ALL
      SELECT e.id, e.parent_id, a.depth + 1
      FROM ${entities} e
      INNER JOIN ancestors a ON e.id = a.parent_id
      WHERE e.workspace_id = ${workspaceId}
        AND a.depth < 100
    )
    SELECT EXISTS (
      SELECT 1 FROM ancestors WHERE id = ${targetAncestorId}
    ) AS found
  `);

  return Boolean(result.at(0)?.["found"]);
};

const config = {
  permissions: { entity: ["update"] },
  body: moveEntityBodySchema,
} satisfies HandlerConfig;

const moveEntity = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    return yield* moveEntityHandler({
      safeDb,
      workspaceId,
      body,
    });
  },
);

export default moveEntity;
