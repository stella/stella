import { Result } from "better-result";
import * as v from "valibot";

import { resultTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { entityRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { detached } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import {
  isTreeParentGuardError,
  lockTree,
  treeParentCycleError,
} from "@/api/lib/db/tree-parent-guard";
import { resolveSiblingNameForInsert } from "@/api/lib/entities/sibling-name-insert";
import { validateParentIdForInsert } from "@/api/lib/entities/validate-parent-id";
import { insertEntityBatch } from "@/api/lib/entity-versions/insert-entity-batch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { checkEntityCreateCapacityForInsert } from "@/api/lib/uploads/entity-create";

import { DESCENDANT_MOVE_MESSAGE, moveEntities } from "../move";

const createFolderFromSelectionBodySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  parentId: v.nullable(resourceIdSchema("entity")),
  entityIds: v.pipe(
    v.array(resourceIdSchema("entity")),
    v.minLength(1),
    v.maxLength(LIMITS.entitiesPageSizeMax),
  ),
});

type CreateFolderFromSelectionBodySchema = v.InferOutput<
  typeof createFolderFromSelectionBodySchema
>;

export type CreateFolderFromSelectionHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: CreateFolderFromSelectionBodySchema;
  flushSearchRepairs?: typeof flushEntitySearchRepairs;
  syncSearchActivity?: typeof syncWorkspaceSearchActivity;
};

// Create a folder and move the selected entities into it in one transaction.
// A refusal aborts the transaction, so a refused move leaves no folder behind.
export const createFolderFromSelectionHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
  flushSearchRepairs = flushEntitySearchRepairs,
  syncSearchActivity = syncWorkspaceSearchActivity,
}: CreateFolderFromSelectionHandlerProps) {
  const requestedName = body.name.trim();
  if (requestedName.length === 0) {
    return Result.err(
      new HandlerError({ status: 400, message: "Entity name is required" }),
    );
  }
  const { parentId } = body;
  const entityIds = [...new Set(body.entityIds)];

  const attempt = await resultTx(safeDb, async (tx) => {
    // The tree lock comes before any row lock, as in a single move.
    await lockTree(tx, { tree: "entities", scopeId: workspaceId });

    const capacity = await checkEntityCreateCapacityForInsert({
      tx,
      workspaceId,
      entityCount: 1,
    });
    if (Result.isError(capacity)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Entities limit reached" }),
      );
    }

    if (parentId !== null) {
      const parentError = await validateParentIdForInsert({
        tx,
        parentId,
        workspaceId,
      });
      if (parentError !== null) {
        return Result.err(
          new HandlerError({ status: 400, message: parentError }),
        );
      }
    }

    const { name } = await resolveSiblingNameForInsert({
      tx,
      workspaceId,
      parentId,
      name: requestedName,
      kind: "folder",
    });
    const folderId = createSafeId<"entity">();
    const folderVersionId = createSafeId<"entityVersion">();
    await insertEntityBatch({
      tx,
      entityRows: [
        {
          id: folderId,
          workspaceId,
          kind: "folder",
          parentId,
          name,
          createdBy: userId,
        },
      ],
      versionRows: [
        {
          id: folderVersionId,
          workspaceId,
          entityId: folderId,
          versionNumber: 1,
          stamp: null,
        },
      ],
      stampOrigin: "issued",
      currentVersions: [{ entityId: folderId, versionId: folderVersionId }],
      fieldRows: [],
    });

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: folderId,
      changes: {
        created: { old: null, new: { kind: "folder", name, parentId } },
      },
    });

    const moved = await moveEntities({
      tx,
      workspaceId,
      entityIds,
      parentId: folderId,
      recordAuditEvent,
    });
    if (Result.isError(moved)) {
      return Result.err(moved.error);
    }

    await enqueueEntitySearchRepairs(tx, [folderId]);

    return Result.ok(folderId);
  });
  if (attempt.isErr() && isTreeParentGuardError(attempt.error, "entities")) {
    return Result.err(treeParentCycleError(DESCENDANT_MOVE_MESSAGE));
  }
  const entityId = yield* attempt;

  detached(
    flushSearchRepairs([entityId]),
    "folder-from-selection.flush-search-repairs",
  );
  detached(
    syncSearchActivity(workspaceId),
    "folder-from-selection.sync-search-activity",
  );

  return Result.ok({ entityId });
};

const config = {
  contract: "patch",
  description:
    "Create a folder and move the given documents, folders, or tasks into " +
    "it in one step. The folder is created under parentId, or at the matter " +
    "root when parentId is null; a name already used there gets a numbered " +
    "suffix. Refused as a whole, creating nothing, when " +
    "the matter is at its entity limit, the parent is not a folder in this " +
    "matter, an entity is not found or is read-only, or a folder would move " +
    "into itself or one of its own descendants.",
  permissions: { entity: ["create", "update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: false,
  },
  body: createFolderFromSelectionBodySchema,
} satisfies WorkspaceHandlerConfig;

const createFolderFromSelection = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    return yield* createFolderFromSelectionHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

declareAggregateMutation(createFolderFromSelection, {
  type: "independent",
  reason:
    "Serialized by the matter's entity tree lock, which every entity reparent and the parent-acyclic trigger take; the folder insert and the moves commit or roll back together.",
});

export default createFolderFromSelection;
