import { panic, Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import { entityRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  isTreeParentGuardError,
  lockTree,
  treeParentCycleError,
} from "@/api/lib/db/tree-parent-guard";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";
import { isRecord } from "@/api/lib/type-guards";

const moveEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  parentId: t.Nullable(tSafeId("entity")),
});

type MoveEntityBodySchema = Static<typeof moveEntityBodySchema>;

export const DESCENDANT_MOVE_MESSAGE =
  "Cannot move a folder into one of its descendants";

export type MoveEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: MoveEntityBodySchema;
  syncSearchActivity?: typeof syncWorkspaceSearchActivity;
};

type LockMovesOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityIds: readonly SafeId<"entity">[];
  parentId: SafeId<"entity"> | null;
};

type LockedMove = {
  entityId: SafeId<"entity">;
  kind: EntityKind;
  oldParentId: SafeId<"entity"> | null;
};

/**
 * Lock the entities (and target folder) and decide whether moving all of
 * them under `parentId` may proceed. Reads and row locks only: the caller
 * writes after an `Ok`, so a rejection returned from its transaction commits
 * nothing. One refused entity refuses the whole set.
 */
const lockMoves = async ({
  tx,
  workspaceId,
  entityIds,
  parentId,
}: LockMovesOptions): Promise<Result<LockedMove[], HandlerError>> => {
  // Lock the entity rows, in id order, to prevent concurrent moves.
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
        inArray(entities.id, [...entityIds]),
        eq(entities.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(entities.id))
    .limit(entityIds.length)
    .for("update");

  if (entityRows.length !== new Set(entityIds).size) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }
  if (entityRows.some((entity) => entity.readOnly)) {
    return Result.err(
      new HandlerError({ status: 409, message: "Entity is read-only" }),
    );
  }

  const locked = entityRows.map((entity) => ({
    entityId: entity.id,
    kind: entity.kind,
    oldParentId: entity.parentId,
  }));
  if (parentId === null) {
    return Result.ok(locked);
  }

  // Prevent moving to itself.
  if (entityIds.includes(parentId)) {
    return Result.err(
      treeParentCycleError("Cannot move an entity into itself"),
    );
  }

  // Lock and verify the target parent is a folder
  // in the same workspace.
  const parentRows = await tx
    .select({ id: entities.id, kind: entities.kind })
    .from(entities)
    .where(
      and(eq(entities.id, parentId), eq(entities.workspaceId, workspaceId)),
    )
    .for("update");
  const parent = parentRows.at(0);

  if (!parent) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Parent entity not found in this workspace",
      }),
    );
  }

  if (parent.kind !== "folder") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Parent entity must be a folder",
      }),
    );
  }

  // Moving a folder must not close a cycle: the target parent may not be
  // one of the moved folders' descendants.
  const folderIds = entityRows
    .filter((entity) => entity.kind === "folder")
    .map((entity) => entity.id);
  if (folderIds.length > 0) {
    const relation = await readAncestorRelation({
      tx,
      startId: parentId,
      targetAncestorIds: folderIds,
      workspaceId,
    });

    if (relation === "descendant") {
      return Result.err(treeParentCycleError(DESCENDANT_MOVE_MESSAGE));
    }
    if (relation === "depth-exceeded") {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Cannot verify the move target: the folder chain is nested too deeply",
        }),
      );
    }
  }

  return Result.ok(locked);
};

type MoveEntitiesOptions = LockMovesOptions & {
  recordAuditEvent: AuditRecorder;
};

/**
 * Move entities under `parentId` (null: the matter root) inside the caller's
 * transaction. Takes the matter's tree lock, locks and checks every entity,
 * then reparents and audits them all and bumps the matter's activity; on an
 * `Err` nothing was written.
 */
export const moveEntities = async ({
  recordAuditEvent,
  ...options
}: MoveEntitiesOptions): Promise<Result<LockedMove[], HandlerError>> => {
  const { tx, workspaceId, entityIds, parentId } = options;
  // Serialize ancestry decisions before taking any entity locks. Disjoint
  // source/target row pairs can still join into a cycle across two moves;
  // the `entities_parent_acyclic` trigger holds the rule for any writer
  // that skips this lock.
  await lockTree(tx, { tree: "entities", scopeId: workspaceId });
  const locked = await lockMoves(options);
  if (Result.isError(locked)) {
    return locked;
  }

  await tx
    .update(entities)
    .set({ parentId, updatedAt: new Date() })
    .where(
      and(
        inArray(entities.id, [...entityIds]),
        eq(entities.workspaceId, workspaceId),
      ),
    );

  await tx
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, workspaceId));

  await recordAuditEvent(
    tx,
    locked.value.map(({ entityId, kind, oldParentId }) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entityId,
      metadata: { kind },
      changes: { parentId: { old: oldParentId, new: parentId } },
    })),
  );

  return locked;
};

export const moveEntityHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
  body,
  syncSearchActivity = syncWorkspaceSearchActivity,
}: MoveEntityHandlerProps) {
  const attempt = await safeDb(async (tx) => {
    const reparented = await moveEntities({
      tx,
      workspaceId,
      entityIds: [body.entityId],
      parentId: body.parentId,
      recordAuditEvent,
    });
    if (Result.isError(reparented)) {
      return reparented;
    }

    return Result.ok();
  });
  if (attempt.isErr() && isTreeParentGuardError(attempt.error, "entities")) {
    return Result.err(treeParentCycleError(DESCENDANT_MOVE_MESSAGE));
  }
  const moved = yield* attempt;
  yield* moved;

  syncSearchActivity(workspaceId).catch(captureError);

  return Result.ok({});
};

/** `unrelated` is the only relation that lets the move proceed: the walk
 *  reached the top of the chain without meeting any target. */
type AncestorRelation = "descendant" | "unrelated" | "depth-exceeded";

type ReadAncestorRelationProps = {
  tx: Transaction;
  startId: SafeId<"entity">;
  targetAncestorIds: readonly SafeId<"entity">[];
  workspaceId: SafeId<"workspace">;
};

/**
 * Walk up the parent chain from `startId` using a recursive
 * CTE (single query) to check whether any of `targetAncestorIds` is an
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
  targetAncestorIds,
  workspaceId,
}: ReadAncestorRelationProps): Promise<AncestorRelation> => {
  const result = await tx.execute(sql`
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
        SELECT 1 FROM ancestors
        WHERE id IN (${sql.join(
          targetAncestorIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      ) AS found,
      EXISTS (
        SELECT 1 FROM ancestors
        WHERE depth >= ${LIMITS.entityAncestorWalkDepthMax}
          AND parent_id IS NOT NULL
      ) AS truncated
  `);

  const row = executedRows(result).at(0);
  if (
    !isRecord(row) ||
    typeof row["found"] !== "boolean" ||
    typeof row["truncated"] !== "boolean"
  ) {
    // Both columns are `EXISTS` aggregates, so the query answers one row for
    // any input. No row means the walk did not run: reading that as "no
    // ancestor" would let the move through without the check.
    return panic("Ancestor relation query returned no row");
  }
  if (row["found"]) {
    return "descendant";
  }
  return row["truncated"] ? "depth-exceeded" : "unrelated";
};

const config = {
  contract: "patch",
  description:
    "Move one document, folder, or task into another folder of the same " +
    "matter, or out to the matter root by passing parentId null. The target " +
    "must be a folder in this matter, a folder may not be moved into itself " +
    "or into one of its own descendants, and a read-only entity is refused.",
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityRealtimeUpdates,
  mcp: { type: "covered", by: "save_document" },
  body: moveEntityBodySchema,
} satisfies WorkspaceHandlerConfig;

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
