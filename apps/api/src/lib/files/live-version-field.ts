import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";

export const fileFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
        entityId: entities.id,
        entityName: entities.name,
        entityVersionId: entityVersions.id,
        propertyId: fields.propertyId,
        versionStamp: entityVersions.stamp,
        verificationCode: entityVersions.verificationCode,
      })
      .from(fields)
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.entityId, entities.id),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      // Exclude tombstoned versions: a withdrawn version's bytes are retained
      // under legal hold but must be unreachable, even to a client that
      // captured the fieldId before the version was tombstoned.
      .where(and(eq(fields.id, fieldId), isNull(entityVersions.deletedAt)))
      .limit(1),
  );

type LiveVersion = {
  tx: Transaction;
  entityId: SafeId<"entity">;
};

class LiveVersionLockProof {
  readonly #version: LiveVersion;
  constructor(version: LiveVersion) {
    this.#version = version;
  }
  get version(): LiveVersion {
    return this.#version;
  }
}

/**
 * Proof that `tx` holds a live version's share lock. Only
 * `lockLiveVersionField` creates one, so whatever demands it (a signed link
 * to a document's file) runs where a tombstone cannot commit underneath it.
 */
export type LiveVersionLock = LiveVersionLockProof;

/**
 * The field of a live version, share-locked with its entity and version until
 * the transaction ends. `fileFieldQuery` alone is a snapshot: a version can be
 * tombstoned between it and whatever the caller does next. The tombstone locks
 * the entity row for update before it writes `deletedAt`, so while this lock
 * is held it waits, and a tombstone that commits first leaves no live row here.
 * A caller that issues access to the version's objects (a signed link) does so
 * inside the same transaction.
 */
export const lockLiveVersionField = async (
  tx: Transaction,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) => {
  const found = (
    await fileFieldQuery(async (read) => await read(tx), fieldId, workspaceId)
  ).at(0);
  if (!found) {
    return null;
  }
  const locked = await withAggregateRowQuery({
    tx,
    aggregate: "entity",
    id: { id: found.entityId, workspaceId },
    mode: "share",
    children: [
      {
        aggregate: "entityVersion",
        id: { id: found.entityVersionId, workspaceId },
      },
      { aggregate: "field", id: { id: fieldId, workspaceId } },
    ],
    select: (lockTx) =>
      lockTx
        .select({
          entityId: entities.id,
          workspaceId: entities.workspaceId,
          versionId: entityVersions.id,
          versionWorkspaceId: entityVersions.workspaceId,
          fieldId: fields.id,
          fieldWorkspaceId: fields.workspaceId,
          content: fields.content,
          versionStamp: entityVersions.stamp,
          verificationCode: entityVersions.verificationCode,
        })
        .from(entities)
        .innerJoin(entityVersions, eq(entityVersions.entityId, entities.id))
        .innerJoin(fields, eq(fields.entityVersionId, entityVersions.id)),
    where: isNull(entityVersions.deletedAt),
  });
  const row = locked.rows.at(0);
  if (!row) {
    return null;
  }
  return {
    ...row,
    lock: new LiveVersionLockProof({ tx, entityId: row.entityId }),
  };
};
