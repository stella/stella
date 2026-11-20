import { Result } from "better-result";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";

import { resultTx, safeDbFromScoped } from "@/api/db/safe-db";
import type { ScopedDb } from "@/api/db/safe-db";
import { detached } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockTree } from "@/api/lib/db/tree-parent-guard";
import { resolveSiblingNameForInsert } from "@/api/lib/entities/sibling-name-insert";
import { insertEntityBatch } from "@/api/lib/entity-versions/insert-entity-batch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { checkEntityCreateCapacityForInsert } from "@/api/lib/uploads/entity-create";

/**
 * Creates the transcript's folder at the matter's root, named after the
 * recording, under the matter's tree lock and entity cap, and records it.
 * The caller has authorized the member to create documents in the matter.
 */
export const createTranscriptFolder = async ({
  scopedDb,
  workspaceId,
  userId,
  title,
  entityCount,
  recordAuditEvent,
}: {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  title: string;
  /** The folder and everything the desktop files in it. */
  entityCount: number;
  recordAuditEvent: AuditRecorder;
}) => {
  const created = await resultTx(safeDbFromScoped(scopedDb), async (tx) => {
    // The tree lock comes first, as in every folder create.
    await lockTree(tx, { tree: "entities", scopeId: workspaceId });
    const capacity = await checkEntityCreateCapacityForInsert({
      tx,
      workspaceId,
      entityCount,
    });
    if (Result.isError(capacity)) {
      return Result.err(
        new HandlerError({
          code: "transcript_matter_entity_limit_reached",
          status: 409,
          message: "This matter has reached its document limit.",
        }),
      );
    }
    // Named as a file manager names a copy: "Title (2)" when taken.
    const { name } = await resolveSiblingNameForInsert({
      tx,
      workspaceId,
      parentId: null,
      name: title,
      kind: "folder",
      numbering: "parenthesized",
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
          parentId: null,
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
        created: {
          old: null,
          new: { kind: "folder", name, parentId: null },
        },
      },
    });
    await enqueueEntitySearchRepairs(tx, [folderId]);
    return Result.ok({ folderId, folderName: name });
  });
  if (Result.isError(created)) {
    return created;
  }
  broadcastWorkspaceResourceUpdated(
    workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: created.value.folderId }),
  );
  detached(
    async () => flushEntitySearchRepairs([created.value.folderId]),
    "desktop-transcript-folder.flush-search-repairs",
  );
  return Result.ok(created.value);
};
