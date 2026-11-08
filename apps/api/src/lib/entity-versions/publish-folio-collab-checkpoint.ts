import { panic } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  entityVersions,
  folioCollabContributions,
  folioCollabPublications,
  folioCollabRooms,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockActiveWorkspaceForBufferIntent,
  lockObjectCleanupIntentsForWriter,
  retirePublishedObjectCleanupIntentsInTransaction,
} from "@/api/lib/buffer-intent-reconciliation";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { COLLABORATION_DOCUMENT_SOURCE } from "@/api/lib/document-source";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
import { lockDocxEditTarget } from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import type { WriteFileVersionResult } from "@/api/lib/entity-versions/write-file-version";
import { officeFileEncryption } from "@/api/lib/files/detect-file-encryption";
import type { MintedFileId } from "@/api/lib/files/file-object-ids";
import { storedDocumentBytes } from "@/api/lib/files/stored-document-bytes";
import {
  FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT,
  FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS,
} from "@/api/lib/folio-collab-room-contract";
import { requestNativeExtractionRun } from "@/api/lib/search/process-extraction";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** A collaboration room publishes the DOCX its editors produced. */
export const PUBLISHED_FILE_ENCRYPTION = officeFileEncryption(DOCX_MIME_TYPE);
const CHECKPOINT_CLEANUP_GRACE_MS = 60_000;

export const hashPublishedFolioCollabBytes = (
  storedBytes: Uint8Array,
): string => hashSha256Hex(storedBytes);

type PublishFolioCollabVersionBody = {
  description?: string;
  expectedGeneration: number;
  expectedSha256Hex: string;
  idempotencyKey: string;
  label?: string;
  roomId: SafeId<"folioCollabRoom">;
};

type FolioCollabCheckpointCut = {
  checkpointFileId: SafeId<"userFile">;
  checkpointSha256Hex: string | null;
  checkpointUpdatedAt: Date | null;
  generation: number;
};

export const matchesFolioCollabCheckpointCut = ({
  checkpoint,
  expectedFileId,
  expectedGeneration,
  expectedSha256Hex,
}: {
  checkpoint: FolioCollabCheckpointCut;
  expectedFileId: SafeId<"userFile">;
  expectedGeneration: number;
  expectedSha256Hex: string;
}) =>
  checkpoint.generation === expectedGeneration &&
  checkpoint.checkpointSha256Hex === expectedSha256Hex &&
  checkpoint.checkpointFileId === expectedFileId &&
  checkpoint.checkpointUpdatedAt !== null;

type FolioCollabPublishedCut = {
  checkpointSha256Hex: string;
  generation: number;
  roomId: SafeId<"folioCollabRoom">;
};

export const matchesFolioCollabPublishedCut = ({
  expectedGeneration,
  expectedSha256Hex,
  published,
  roomId,
}: {
  expectedGeneration: number;
  expectedSha256Hex: string;
  published: FolioCollabPublishedCut;
  roomId: SafeId<"folioCollabRoom">;
}) =>
  published.roomId === roomId &&
  published.generation === expectedGeneration &&
  published.checkpointSha256Hex === expectedSha256Hex;

type PublicationCut = Pick<
  PublishFolioCollabVersionBody,
  "expectedGeneration" | "expectedSha256Hex" | "idempotencyKey" | "roomId"
>;

const findPublicationByIdempotencyKey = async (
  tx: Transaction,
  idempotencyKey: string,
) => {
  const prior = await tx
    .select({
      checkpointSha256Hex: folioCollabPublications.checkpointSha256Hex,
      generation: folioCollabPublications.generation,
      roomId: folioCollabPublications.roomId,
      versionId: folioCollabPublications.entityVersionId,
      versionNumber: entityVersions.versionNumber,
    })
    .from(folioCollabPublications)
    .innerJoin(
      entityVersions,
      eq(entityVersions.id, folioCollabPublications.entityVersionId),
    )
    .where(eq(folioCollabPublications.idempotencyKey, idempotencyKey))
    .limit(1);
  return prior.at(0);
};

type LoadPublicationPreliminaryOptions = {
  cut: PublicationCut;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

export const loadPublicationPreliminary = async ({
  cut: { expectedGeneration, expectedSha256Hex, idempotencyKey, roomId },
  tx,
  workspaceId,
}: LoadPublicationPreliminaryOptions) => {
  const published = await findPublicationByIdempotencyKey(tx, idempotencyKey);
  if (published) {
    if (
      !matchesFolioCollabPublishedCut({
        expectedGeneration,
        expectedSha256Hex,
        published,
        roomId,
      })
    ) {
      return { status: "idempotency-conflict" } as const;
    }
    return {
      status: "published",
      versionId: published.versionId,
      versionNumber: published.versionNumber,
    } as const;
  }

  const rooms = await tx
    .select({
      checkpointFileId: folioCollabRooms.docxCheckpointFileId,
      checkpointScanWarnings: folioCollabRooms.docxCheckpointScanWarnings,
      checkpointSha256Hex: folioCollabRooms.docxCheckpointSha256Hex,
      checkpointSnapshotSha256Hex:
        folioCollabRooms.docxCheckpointSnapshotSha256Hex,
      checkpointSizeBytes: folioCollabRooms.docxCheckpointSizeBytes,
      checkpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
      entityId: folioCollabRooms.entityId,
      fileName: folioCollabRooms.fileName,
      generation: folioCollabRooms.generation,
      propertyId: folioCollabRooms.propertyId,
    })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.id, roomId),
        eq(folioCollabRooms.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const room = rooms.at(0);
  return room
    ? ({ status: "checkpoint", room } as const)
    : ({ status: "missing" } as const);
};

export type PublicationPreliminary = Awaited<
  ReturnType<typeof loadPublicationPreliminary>
>;

type CheckpointRoom = Extract<
  PublicationPreliminary,
  { status: "checkpoint" }
>["room"];

export type PublicationSource = {
  cleanupIntentId: SafeId<"pendingUpload">;
  fileId: MintedFileId;
  key: string;
  organizationId: SafeId<"organization">;
};

type RoomScopeOptions = {
  roomId: SafeId<"folioCollabRoom">;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

const lockPublicationRoom = async ({
  roomId,
  tx,
  workspaceId,
}: RoomScopeOptions) => {
  const { rows: rooms } = await withAggregateRowQuery({
    aggregate: "folioCollabRoom",
    id: { id: roomId, workspaceId },
    tx,
    mode: "update",
    select: (lockTx) =>
      lockTx
        .select({
          id: folioCollabRooms.id,
          workspaceId: folioCollabRooms.workspaceId,
          baseVersionId: folioCollabRooms.baseVersionId,
          checkpointFileId: folioCollabRooms.docxCheckpointFileId,
          checkpointSha256Hex: folioCollabRooms.docxCheckpointSha256Hex,
          checkpointSnapshotSha256Hex:
            folioCollabRooms.docxCheckpointSnapshotSha256Hex,
          checkpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
          entityId: folioCollabRooms.entityId,
          generation: folioCollabRooms.generation,
          propertyId: folioCollabRooms.propertyId,
        })
        .from(folioCollabRooms),
  });
  return rooms.at(0);
};

type LockedPublicationRoom = NonNullable<
  Awaited<ReturnType<typeof lockPublicationRoom>>
>;

const loadRoomContributors = async ({
  roomId,
  tx,
  workspaceId,
}: RoomScopeOptions) =>
  await tx
    .select({
      id: folioCollabContributions.id,
      updatedAt: folioCollabContributions.updatedAt,
      userId: folioCollabContributions.userId,
    })
    .from(folioCollabContributions)
    .where(
      and(
        eq(folioCollabContributions.roomId, roomId),
        eq(folioCollabContributions.workspaceId, workspaceId),
      ),
    )
    .orderBy(
      asc(folioCollabContributions.createdAt),
      asc(folioCollabContributions.id),
    )
    .limit(FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT);

type RoomContributor = Awaited<ReturnType<typeof loadRoomContributors>>[number];

type RecordRoomPublicationOptions = {
  checkpointKey: string;
  contributors: RoomContributor[];
  cut: PublicationCut;
  nextCheckpointFileId: SafeId<"userFile">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  room: LockedPublicationRoom;
  sourceCleanupIntentId: SafeId<"pendingUpload">;
  tx: Transaction;
  versionId: SafeId<"entityVersion">;
  versionNumber: number;
  workspaceId: SafeId<"workspace">;
};

/**
 * Moves the room onto the published version inside the version write: clears
 * the checkpoint, records the publication, carries connected contributors
 * over, and queues the old checkpoint object for cleanup.
 */
const recordRoomPublication = async ({
  checkpointKey,
  contributors,
  cut: { expectedGeneration, expectedSha256Hex, idempotencyKey, roomId },
  nextCheckpointFileId,
  organizationId,
  recordAuditEvent,
  room,
  sourceCleanupIntentId,
  tx,
  versionId,
  versionNumber,
  workspaceId,
}: RecordRoomPublicationOptions) => {
  await tx
    .update(folioCollabRooms)
    .set({
      baseVersionId: versionId,
      savedSnapshotCut:
        room.checkpointSnapshotSha256Hex === null
          ? null
          : { versionId, sha256Hex: room.checkpointSnapshotSha256Hex },
      docxCheckpointFileId: nextCheckpointFileId,
      docxCheckpointScanWarnings: null,
      docxCheckpointSha256Hex: null,
      docxCheckpointSnapshotSha256Hex: null,
      docxCheckpointSizeBytes: null,
      docxCheckpointUpdatedAt: null,
    })
    .where(
      and(
        eq(folioCollabRooms.id, roomId),
        eq(folioCollabRooms.workspaceId, workspaceId),
        eq(folioCollabRooms.generation, expectedGeneration),
        eq(folioCollabRooms.docxCheckpointSha256Hex, expectedSha256Hex),
      ),
    );
  await tx.insert(folioCollabPublications).values({
    checkpointSha256Hex: expectedSha256Hex,
    snapshotSha256Hex: room.checkpointSnapshotSha256Hex,
    entityId: room.entityId,
    entityVersionId: versionId,
    generation: expectedGeneration,
    id: createSafeId<"folioCollabPublication">(),
    idempotencyKey,
    roomId,
    workspaceId,
  });
  await tx
    .delete(folioCollabContributions)
    .where(
      and(
        eq(folioCollabContributions.roomId, roomId),
        eq(folioCollabContributions.workspaceId, workspaceId),
      ),
    );
  const activeContributorCutoff =
    Temporal.Now.instant().epochMilliseconds -
    FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS;
  const connectedContributorRows = contributors.filter(
    (contributor) => contributor.updatedAt.getTime() > activeContributorCutoff,
  );
  if (connectedContributorRows.length > 0) {
    await tx.insert(folioCollabContributions).values(
      connectedContributorRows.map((contributor) => ({
        entityId: room.entityId,
        id: createSafeId<"folioCollabContribution">(),
        roomId,
        sinceVersionId: versionId,
        updatedAt: contributor.updatedAt,
        userId: contributor.userId,
        workspaceId,
      })),
    );
  }
  // audit: skip — durable storage recovery bookkeeping; the room
  // publication and canonical entity/version mutations are audited.
  await tx.insert(bufferObjectCleanupIntents).values({
    id: createSafeId<"pendingUpload">(),
    nextAttemptAt: new Date(
      Temporal.Now.instant().epochMilliseconds + CHECKPOINT_CLEANUP_GRACE_MS,
    ),
    objectKey: checkpointKey,
    organizationId,
    status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
    workspaceId,
  });
  await retirePublishedObjectCleanupIntentsInTransaction({
    intentIds: [sourceCleanupIntentId],
    tx,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
    resourceId: roomId,
    changes: {
      baseVersionId: { old: room.baseVersionId, new: versionId },
      checkpointSha256Hex: {
        old: expectedSha256Hex,
        new: null,
      },
    },
    metadata: { versionNumber },
  });
};

const publicationOutcome = (
  versionWrite: WriteFileVersionResult,
  entityId: SafeId<"entity">,
) => {
  switch (versionWrite.status) {
    case "ok":
      return {
        entityId,
        fieldId: versionWrite.fieldId,
        status: "created",
        versionId: versionWrite.entityVersionId,
        versionNumber: versionWrite.versionNumber,
      } as const;
    case "current-version-changed":
    case "current-version-not-found":
    case "source-version-not-found":
    case "missing-file-field":
    case "target-file-not-found":
      return { status: "base-drift" } as const;
    case "entity-not-found":
      return { status: "missing" } as const;
    case "entity-read-only":
      return { status: "read-only" } as const;
    case "edit-session-open":
    case "workspace-not-active":
      return { status: "unavailable" } as const;
    case "replayed":
      return panic(
        "Collaboration publication cannot replay a derived comparison",
      );
    default: {
      versionWrite satisfies never;
      return panic(`Unhandled version write: ${String(versionWrite)}`);
    }
  }
};

type PublishCheckpointOptions = {
  body: PublishFolioCollabVersionBody;
  checkpointKey: string;
  checkpointRoom: CheckpointRoom;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  source: PublicationSource;
  storedSha256Hex: string;
  storedSizeBytes: number;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const publishCheckpointInTransaction = async ({
  body,
  checkpointKey,
  checkpointRoom,
  organizationId,
  recordAuditEvent,
  source,
  storedSha256Hex,
  storedSizeBytes,
  tx,
  userId,
  workspaceId,
}: PublishCheckpointOptions) => {
  const { description, label, roomId } = body;
  await lockActiveWorkspaceForBufferIntent({
    tx,
    workspaceId,
    organizationId,
    mode: "update",
  });
  await lockDocxEditTarget({
    entityId: checkpointRoom.entityId,
    propertyId: checkpointRoom.propertyId,
    tx,
    workspaceId,
  });
  const room = await lockPublicationRoom({ roomId, tx, workspaceId });
  if (!room) {
    return { status: "missing" } as const;
  }

  const alreadyPublished = await findPublicationByIdempotencyKey(
    tx,
    body.idempotencyKey,
  );
  if (alreadyPublished) {
    if (
      !matchesFolioCollabPublishedCut({
        expectedGeneration: body.expectedGeneration,
        expectedSha256Hex: body.expectedSha256Hex,
        published: alreadyPublished,
        roomId,
      })
    ) {
      return { status: "idempotency-conflict" } as const;
    }
    return {
      status: "idempotent",
      versionId: alreadyPublished.versionId,
      versionNumber: alreadyPublished.versionNumber,
    } as const;
  }
  if (
    !matchesFolioCollabCheckpointCut({
      checkpoint: room,
      expectedFileId: checkpointRoom.checkpointFileId,
      expectedGeneration: body.expectedGeneration,
      expectedSha256Hex: body.expectedSha256Hex,
    })
  ) {
    return { status: "checkpoint-changed" } as const;
  }
  await lockObjectCleanupIntentsForWriter(tx, [source.cleanupIntentId]);

  const contributors = await loadRoomContributors({ roomId, tx, workspaceId });
  const contributorUserIds = contributors.map(
    (contributor) => contributor.userId,
  );
  const versionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const nextCheckpointFileId = createSafeId<"userFile">();
  const versionWrite = await writeFileVersion({
    // The publish request authorized the member before this transaction.
    authority: CALLER_AUTHORIZED,
    afterWrite: async ({ versionNumber }) => {
      await recordRoomPublication({
        checkpointKey,
        contributors,
        cut: body,
        nextCheckpointFileId,
        organizationId,
        recordAuditEvent,
        room,
        sourceCleanupIntentId: source.cleanupIntentId,
        tx,
        versionId,
        versionNumber,
        workspaceId,
      });
    },
    entityId: room.entityId,
    entityVersionId: versionId,
    fieldId,
    fileId: source.fileId,
    fileName: checkpointRoom.fileName,
    mimeType: DOCX_MIME_TYPE,
    encryption: PUBLISHED_FILE_ENCRYPTION,
    organizationId,
    recordAuditEvent,
    scanWarnings: checkpointRoom.checkpointScanWarnings ?? undefined,
    sha256Hex: storedSha256Hex,
    sizeBytes: storedSizeBytes,
    source: COLLABORATION_DOCUMENT_SOURCE,
    tx,
    userId,
    versionMetadata: {
      collaborationContributorUserIds: contributorUserIds,
      ...(description !== undefined && { description }),
      ...(label !== undefined && { label }),
    },
    workspaceId,
    writePolicy: {
      type: "collaboration-room-publish",
      expectedCurrentVersionId: room.baseVersionId,
      filePropertyId: room.propertyId,
    },
  });
  if (versionWrite.status === "ok") {
    await requestNativeExtractionRun({ entityId: room.entityId, tx });
  }
  return publicationOutcome(versionWrite, room.entityId);
};

export const preparePublicationBytes = async (
  checkpointBytes: Uint8Array<ArrayBuffer>,
  expectedSha256Hex: string,
) => {
  // The room's checkpoint can hold whatever a collaborator pasted in,
  // including a stamped download of this document. The published version
  // stores, and records, bytes without a reference.
  const { bytes: storedBytes, strippedArchive } =
    await storedDocumentBytes(checkpointBytes);
  const storedSha256Hex =
    strippedArchive === null
      ? expectedSha256Hex
      : hashPublishedFolioCollabBytes(storedBytes);

  return { storedBytes, storedSha256Hex };
};
