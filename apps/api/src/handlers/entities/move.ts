import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { entities, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { AuditContext } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";

const moveEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  parentId: t.Nullable(tSafeId("entity")),
});

type MoveEntityBodySchema = Static<typeof moveEntityBodySchema>;

type MoveEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  auditContext: AuditContext;
  body: MoveEntityBodySchema;
};

const moveEntityHandler = async function* ({
  safeDb,
  workspaceId,
  auditContext,
  body,
}: MoveEntityHandlerProps) {
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
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
        return {
          ok: false as const,
          status: 404 as const,
          message: "Entity not found",
        };
      }
      if (entity.readOnly) {
        return {
          ok: false as const,
          status: 409 as const,
          message: "Entity is read-only",
        };
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
        await writeAuditLog(
          {
            ...auditContext,
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: body.entityId,
            changes: {
              parentId: {
                old: oldParentId,
                new: null,
              },
            },
          },
          tx,
        );
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

      const oldParentId = entity.parentId;

      await tx
        .update(entities)
        .set({ parentId: body.parentId, updatedAt: new Date() })
        .where(eq(entities.id, body.entityId));

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await writeAuditLog(
        {
          ...auditContext,
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: body.entityId,
          changes: {
            parentId: {
              old: oldParentId,
              new: body.parentId,
            },
          },
        },
        tx,
      );

      return { ok: true as const };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  syncWorkspaceSearchActivity(workspaceId).catch(captureError);

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

  const { found = false } = result.at(0) ?? {};
  return found;
};

const config = {
  permissions: { entity: ["update"] },
  body: moveEntityBodySchema,
} satisfies HandlerConfig;

const moveEntity = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, user, request, body }) {
    return yield* moveEntityHandler({
      safeDb,
      workspaceId,
      auditContext: createAuditContext({
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        request,
      }),
      body,
    });
  },
);

export default moveEntity;
