import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";

const moveEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  parentId: t.Nullable(tSafeId("entity")),
});

type MoveEntityBodySchema = Static<typeof moveEntityBodySchema>;

export type MoveEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: MoveEntityBodySchema;
};

export const moveEntityHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
  body,
}: MoveEntityHandlerProps) {
  yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      // Lock the entity row to prevent concurrent moves.
      const entityRows = await tx
        .select({
          id: entities.id,
          kind: entities.kind,
          parentId: entities.parentId,
          readOnly: entities.readOnly,
        })
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
        throw new HandlerError({ status: 404, message: "Entity not found" });
      }
      if (entity.readOnly) {
        throw new HandlerError({ status: 409, message: "Entity is read-only" });
      }

      if (body.parentId === null) {
        const oldParentId = entity.parentId;

        await tx
          .update(entities)
          .set({ parentId: null, updatedAt: new Date() })
          .where(eq(entities.id, body.entityId));
        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: body.entityId,
          metadata: { kind: entity.kind },
          changes: {
            parentId: {
              old: oldParentId,
              new: null,
            },
          },
        });
        return {};
      }

      // Prevent moving to itself.
      if (body.entityId === body.parentId) {
        throw new HandlerError({
          status: 400,
          message: "Cannot move an entity into itself",
        });
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
        throw new HandlerError({
          status: 400,
          message: "Parent entity not found in this workspace",
        });
      }

      if (parent.kind !== "folder") {
        throw new HandlerError({
          status: 400,
          message: "Parent entity must be a folder",
        });
      }

      // If the entity being moved is a folder, prevent cycles
      // by checking that the target parent is not a descendant.
      if (entity.kind === "folder") {
        const relation = await readAncestorRelation({
          tx,
          startId: body.parentId,
          targetAncestorId: body.entityId,
          workspaceId,
        });

        if (relation === "descendant") {
          throw new HandlerError({
            status: 400,
            message: "Cannot move a folder into one of its descendants",
          });
        }
        if (relation === "depth-exceeded") {
          throw new HandlerError({
            status: 400,
            message:
              "Cannot verify the move target: the folder chain is nested too deeply",
          });
        }
      }

      const oldParentId = entity.parentId;

      await tx
        .update(entities)
        .set({ parentId: body.parentId, updatedAt: new Date() })
        .where(eq(entities.id, body.entityId));

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: body.entityId,
        metadata: { kind: entity.kind },
        changes: {
          parentId: {
            old: oldParentId,
            new: body.parentId,
          },
        },
      });

      return {};
    }),
  );

  syncWorkspaceSearchActivity(workspaceId).catch(captureError);

  return Result.ok({});
};

/** `unrelated` is the only relation that lets the move proceed: the walk
 *  reached the top of the chain without meeting the target. */
type AncestorRelation = "descendant" | "unrelated" | "depth-exceeded";

type ReadAncestorRelationProps = {
  tx: Transaction;
  startId: SafeId<"entity">;
  targetAncestorId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Walk up the parent chain from `startId` using a recursive
 * CTE (single query) to check whether `targetAncestorId` is an
 * ancestor.
 *
 * The walk is bounded to `entityAncestorWalkDepthMax` levels so a circular
 * parent reference cannot make it run forever. A chain that still continues
 * at the cap returns `depth-exceeded`: the query cannot prove the target is
 * absent from the untraversed remainder, so the caller refuses the move
 * instead of reading a truncated walk as "no cycle".
 */
const readAncestorRelation = async ({
  tx,
  startId,
  targetAncestorId,
  workspaceId,
}: ReadAncestorRelationProps): Promise<AncestorRelation> => {
  const result = await tx.execute<{ found: boolean; truncated: boolean }>(sql`
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
        AND a.depth < ${LIMITS.entityAncestorWalkDepthMax}
    )
    SELECT
      EXISTS (
        SELECT 1 FROM ancestors WHERE id = ${targetAncestorId}
      ) AS found,
      EXISTS (
        SELECT 1 FROM ancestors
        WHERE depth >= ${LIMITS.entityAncestorWalkDepthMax}
          AND parent_id IS NOT NULL
      ) AS truncated
  `);

  const row = result.at(0);
  if (row?.found === true) {
    return "descendant";
  }
  return row?.truncated === true ? "depth-exceeded" : "unrelated";
};

const config = {
  description:
    "Move one document, folder, or task into another folder of the same " +
    "matter, or out to the matter root by passing parentId null. The target " +
    "must be a folder in this matter, a folder may not be moved into itself " +
    "or into one of its own descendants, and a read-only entity is refused.",
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "save_document" },
  body: moveEntityBodySchema,
} satisfies HandlerConfig;

const moveEntity = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    return yield* moveEntityHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default moveEntity;
