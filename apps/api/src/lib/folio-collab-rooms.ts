import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { roles } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { FolioCollabTokenPermissions } from "@/api/db/schema";
import {
  bufferObjectCleanupIntents,
  desktopEditSessions,
  folioCollabRooms,
  folioCollabRoomTokens,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import { lockDocxEditTarget } from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { createFileKey } from "@/api/lib/files/utils";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import {
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  FOLIO_COLLAB_TOKEN_TTL_MS,
} from "@/api/lib/folio-collab-room-contract";
import { isMemberRole } from "@/api/lib/member-roles";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  deleteS3ObjectWithSignal,
  readS3ObjectIfPresent,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const FOLIO_COLLAB_TOKEN_PART_LENGTH = 32;
const FOLIO_COLLAB_TOKEN_CLEANUP_BATCH_SIZE = 100;
const FOLIO_COLLAB_SNAPSHOT_CLEANUP_GRACE_MS = 60_000;
const FOLIO_COLLAB_S3_DELETE_TIMEOUT_MS = 10_000;

export {
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  FOLIO_COLLAB_TOKEN_TTL_MS,
  FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
};

export const createFolioCollabToken = () =>
  Bun.randomUUIDv7()
    .replaceAll("-", "")
    .slice(0, FOLIO_COLLAB_TOKEN_PART_LENGTH) +
  Bun.randomUUIDv7()
    .replaceAll("-", "")
    .slice(0, FOLIO_COLLAB_TOKEN_PART_LENGTH);

export const hashFolioCollabToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

export const computeFolioCollabTokenExpiresAt = (now = new Date()) =>
  new Date(now.getTime() + FOLIO_COLLAB_TOKEN_TTL_MS);

export type FolioCollabStoredRoomFile = {
  fileId: SafeId<"userFile">;
  mimeType: typeof DOCX_MIME_TYPE | typeof FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE;
};

export const collectFolioCollabStoredRoomFiles = ({
  docxCheckpointFileId,
  docxCheckpointUpdatedAt,
  yjsSnapshotFileId,
  yjsSnapshotUpdatedAt,
}: {
  docxCheckpointFileId: SafeId<"userFile">;
  docxCheckpointUpdatedAt: Date | null;
  yjsSnapshotFileId: SafeId<"userFile">;
  yjsSnapshotUpdatedAt: Date | null;
}) => {
  const storedFiles: FolioCollabStoredRoomFile[] = [];

  if (yjsSnapshotUpdatedAt !== null) {
    storedFiles.push({
      fileId: yjsSnapshotFileId,
      mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    });
  }

  if (docxCheckpointUpdatedAt !== null) {
    storedFiles.push({
      fileId: docxCheckpointFileId,
      mimeType: DOCX_MIME_TYPE,
    });
  }

  return storedFiles;
};

const deleteStoredRoomFile = async ({
  file,
  organizationId,
  roomId,
  workspaceId,
}: {
  file: FolioCollabStoredRoomFile;
  organizationId: SafeId<"organization">;
  roomId: SafeId<"folioCollabRoom">;
  workspaceId: SafeId<"workspace">;
}) => {
  const key = createFileKey({
    fileId: file.fileId,
    mimeType: file.mimeType,
    organizationId,
    workspaceId,
  });

  await deleteS3ObjectWithSignal(
    key,
    AbortSignal.timeout(FOLIO_COLLAB_S3_DELETE_TIMEOUT_MS),
  ).catch((error: unknown) => {
    captureError(error, { roomId, storageKey: key });
  });
};

export const deleteFolioCollabStoredRoomFiles = async ({
  files,
  organizationId,
  roomId,
  workspaceId,
}: {
  files: FolioCollabStoredRoomFile[];
  organizationId: SafeId<"organization">;
  roomId: SafeId<"folioCollabRoom">;
  workspaceId: SafeId<"workspace">;
}) => {
  await Promise.all(
    files.map(
      async (file) =>
        await deleteStoredRoomFile({
          file,
          organizationId,
          roomId,
          workspaceId,
        }),
    ),
  );
};

export type AuthorizedFolioCollabRoom = {
  canEdit: boolean;
  entityId: SafeId<"entity">;
  fileName: string;
  generation: number;
  organizationId: SafeId<"organization">;
  propertyId: SafeId<"property">;
  roomId: SafeId<"folioCollabRoom">;
  scopedDb: ScopedDb;
  tokenExpiresAt: Date;
  tokenId: SafeId<"folioCollabRoomToken">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type IssueFolioCollabTokenOptions = {
  generation: number;
  permissions: FolioCollabTokenPermissions;
  roomId: SafeId<"folioCollabRoom">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type FolioCollabTokenCleanupDb = {
  execute: (query: SQL) => Promise<unknown>;
};

export const cleanupExpiredFolioCollabRoomTokens = async ({
  db,
  workspaceId,
}: {
  db: FolioCollabTokenCleanupDb;
  workspaceId: SafeId<"workspace">;
}) => {
  await db.execute(sql`
    DELETE FROM ${folioCollabRoomTokens}
    WHERE ${folioCollabRoomTokens.id} IN (
      SELECT ${folioCollabRoomTokens.id}
      FROM ${folioCollabRoomTokens}
      WHERE ${folioCollabRoomTokens.workspaceId} = ${workspaceId}
        AND ${folioCollabRoomTokens.expiresAt} < CURRENT_TIMESTAMP
      ORDER BY ${folioCollabRoomTokens.expiresAt}, ${folioCollabRoomTokens.id}
      LIMIT ${FOLIO_COLLAB_TOKEN_CLEANUP_BATCH_SIZE}
    )
  `);
};

export const issueFolioCollabToken = async ({
  generation,
  permissions,
  roomId,
  tx,
  userId,
  workspaceId,
}: IssueFolioCollabTokenOptions) => {
  const token = createFolioCollabToken();
  const now = new Date();
  const tokenExpiresAt = computeFolioCollabTokenExpiresAt(now);
  await cleanupExpiredFolioCollabRoomTokens({ db: tx, workspaceId });
  await tx.insert(folioCollabRoomTokens).values({
    expiresAt: tokenExpiresAt,
    generation,
    id: createSafeId<"folioCollabRoomToken">(),
    permissions,
    roomId,
    tokenHash: hashFolioCollabToken(token),
    userId,
    workspaceId,
  });

  return { token, tokenExpiresAt };
};

export const refreshFolioCollabToken = async ({
  tokenId,
  tx,
}: {
  tokenId: SafeId<"folioCollabRoomToken">;
  tx: Transaction;
}) => {
  const tokenExpiresAt = computeFolioCollabTokenExpiresAt();
  const refreshed = await tx
    .update(folioCollabRoomTokens)
    .set({ expiresAt: tokenExpiresAt })
    .where(eq(folioCollabRoomTokens.id, tokenId))
    .returning({ id: folioCollabRoomTokens.id });

  if (!refreshed.at(0)) {
    return null;
  }

  return { tokenExpiresAt };
};

export type FolioCollabRoomAuthorizationResult =
  | { status: "authorized"; value: AuthorizedFolioCollabRoom }
  | { status: "generation-conflict" }
  | { status: "missing" }
  | { status: "token-expired" }
  | { status: "workspace-access-revoked" };

type FolioCollabRoomDecisionInput = {
  actualGeneration: number;
  expiresAt: Date;
  now: Date;
  organizationRole: string | null;
  tokenCanEdit: boolean;
  tokenGeneration: number;
  workspaceClientId: string | null;
  workspaceMemberId: string | null;
};

export const canUseFolioCollabWorkspace = ({
  organizationRole,
  workspaceClientId,
  workspaceMemberId,
}: Pick<
  FolioCollabRoomDecisionInput,
  "organizationRole" | "workspaceClientId" | "workspaceMemberId"
>) =>
  organizationRole !== null &&
  isMemberRole(organizationRole) &&
  (workspaceMemberId !== null ||
    (workspaceClientId !== null &&
      (organizationRole === "owner" || organizationRole === "admin")));

export const decideFolioCollabRoomAuthorization = ({
  actualGeneration,
  expiresAt,
  now,
  organizationRole,
  tokenCanEdit,
  tokenGeneration,
  workspaceClientId,
  workspaceMemberId,
}: FolioCollabRoomDecisionInput):
  | { status: "authorized"; canEdit: boolean }
  | { status: "generation-conflict" }
  | { status: "token-expired" }
  | { status: "workspace-access-revoked" } => {
  if (expiresAt.getTime() <= now.getTime()) {
    return { status: "token-expired" };
  }

  if (tokenGeneration !== actualGeneration) {
    return { status: "generation-conflict" };
  }

  const role = organizationRole;
  const canUseWorkspace = canUseFolioCollabWorkspace({
    organizationRole: role,
    workspaceClientId,
    workspaceMemberId,
  });
  if (role === null || !isMemberRole(role) || !canUseWorkspace) {
    return { status: "workspace-access-revoked" };
  }

  const canEdit =
    tokenCanEdit && roles[role].authorize({ entity: ["update"] }).success;
  return { status: "authorized", canEdit };
};

export const authorizeFolioCollabRoom = async ({
  roomId,
  token,
}: {
  roomId: SafeId<"folioCollabRoom">;
  token: string;
}): Promise<FolioCollabRoomAuthorizationResult> => {
  const tokenHash = hashFolioCollabToken(token);

  // The token hash is the only trusted lookup key before its tenant is known.
  // This owner-level read derives one workspace, then every subsequent room
  // operation uses the scoped database capability returned below.
  const rows = await rootDb
    .select({
      entityId: folioCollabRooms.entityId,
      expiresAt: folioCollabRoomTokens.expiresAt,
      fileName: folioCollabRooms.fileName,
      generation: folioCollabRooms.generation,
      organizationId: workspaces.organizationId,
      organizationRole: member.role,
      permissions: folioCollabRoomTokens.permissions,
      propertyId: folioCollabRooms.propertyId,
      tokenId: folioCollabRoomTokens.id,
      tokenGeneration: folioCollabRoomTokens.generation,
      userId: folioCollabRoomTokens.userId,
      workspaceId: folioCollabRooms.workspaceId,
      workspaceClientId: workspaces.clientId,
      workspaceMemberId: workspaceMembers.id,
    })
    .from(folioCollabRoomTokens)
    .innerJoin(
      folioCollabRooms,
      and(
        eq(folioCollabRoomTokens.roomId, folioCollabRooms.id),
        eq(folioCollabRoomTokens.workspaceId, folioCollabRooms.workspaceId),
      ),
    )
    .innerJoin(workspaces, eq(folioCollabRooms.workspaceId, workspaces.id))
    .leftJoin(
      member,
      and(
        eq(member.userId, folioCollabRoomTokens.userId),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, folioCollabRoomTokens.userId),
        eq(workspaceMembers.workspaceId, folioCollabRooms.workspaceId),
      ),
    )
    .where(
      and(
        eq(folioCollabRoomTokens.roomId, roomId),
        eq(folioCollabRoomTokens.tokenHash, tokenHash),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  if (!row) {
    return { status: "missing" };
  }

  const decision = decideFolioCollabRoomAuthorization({
    actualGeneration: row.generation,
    expiresAt: row.expiresAt,
    now: new Date(),
    organizationRole: row.organizationRole,
    tokenCanEdit: row.permissions.canEdit,
    tokenGeneration: row.tokenGeneration,
    workspaceClientId: row.workspaceClientId,
    workspaceMemberId: row.workspaceMemberId,
  });
  if (decision.status !== "authorized") {
    return decision;
  }

  return {
    status: "authorized",
    value: {
      canEdit: decision.canEdit,
      entityId: row.entityId,
      fileName: row.fileName,
      generation: row.generation,
      organizationId: row.organizationId,
      propertyId: row.propertyId,
      roomId,
      scopedDb: createRootScopedDb({
        organizationId: row.organizationId,
        userId: brandPersistedUserId(row.userId),
        workspaceIds: [row.workspaceId],
      }),
      tokenExpiresAt: row.expiresAt,
      tokenId: row.tokenId,
      userId: brandPersistedUserId(row.userId),
      workspaceId: row.workspaceId,
    },
  };
};

type TouchFolioCollabRoomResult =
  | { status: "active"; activeAt: Date }
  | { status: "desktop-conflict" }
  | { status: "room-missing" };

export const touchFolioCollabRoom = async (
  value: AuthorizedFolioCollabRoom,
): Promise<TouchFolioCollabRoomResult> => {
  const touchedAt = new Date();
  return await value.scopedDb(async (tx) => {
    await lockDocxEditTarget({
      entityId: value.entityId,
      propertyId: value.propertyId,
      tx,
      workspaceId: value.workspaceId,
    });

    const desktopSessions = await tx
      .select({ id: desktopEditSessions.id })
      .from(desktopEditSessions)
      .where(
        and(
          eq(desktopEditSessions.entityId, value.entityId),
          eq(desktopEditSessions.propertyId, value.propertyId),
          eq(desktopEditSessions.workspaceId, value.workspaceId),
          ...liveDesktopEditSessionPredicates(touchedAt),
        ),
      )
      .limit(1);
    if (desktopSessions.at(0)) {
      return {
        status: "desktop-conflict",
      } satisfies TouchFolioCollabRoomResult;
    }

    const updated = await tx
      .update(folioCollabRooms)
      .set({ lastActivityAt: touchedAt })
      .where(
        and(
          eq(folioCollabRooms.id, value.roomId),
          eq(folioCollabRooms.workspaceId, value.workspaceId),
        ),
      )
      .returning({ id: folioCollabRooms.id });

    return updated.at(0)
      ? ({
          status: "active",
          activeAt: touchedAt,
        } satisfies TouchFolioCollabRoomResult)
      : ({ status: "room-missing" } satisfies TouchFolioCollabRoomResult);
  });
};

export const loadFolioCollabSnapshot = async (
  value: AuthorizedFolioCollabRoom,
  readObject = readS3ObjectIfPresent,
) => {
  const readPointer = async () => {
    const rooms = await value.scopedDb(async (tx) =>
      tx
        .select({
          generation: folioCollabRooms.generation,
          yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
          yjsSnapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabRooms)
        .where(
          and(
            eq(folioCollabRooms.id, value.roomId),
            eq(folioCollabRooms.workspaceId, value.workspaceId),
          ),
        )
        .limit(1),
    );
    return rooms.at(0) ?? null;
  };

  let room = await readPointer();
  if (!room) {
    return null;
  }
  if (!room.yjsSnapshotUpdatedAt) {
    return { generation: room.generation, snapshotBase64: null };
  }

  const readSnapshot = async (fileId: SafeId<"userFile">) =>
    await readObject(
      createFileKey({
        fileId,
        mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
        organizationId: value.organizationId,
        workspaceId: value.workspaceId,
      }),
      AbortSignal.timeout(10_000),
    );

  let buffer = await readSnapshot(room.yjsSnapshotFileId);
  if (buffer === null) {
    const previousFileId = room.yjsSnapshotFileId;
    room = await readPointer();
    if (!room) {
      return null;
    }
    if (!room.yjsSnapshotUpdatedAt) {
      return { generation: room.generation, snapshotBase64: null };
    }
    if (room.yjsSnapshotFileId === previousFileId) {
      return panic("Current collaboration snapshot object is missing");
    }
    buffer = await readSnapshot(room.yjsSnapshotFileId);
    if (buffer === null) {
      return panic("Replacement collaboration snapshot object is missing");
    }
  }

  return {
    generation: room.generation,
    snapshotBase64: Buffer.from(buffer).toString("base64"),
  };
};

export type StoreFolioCollabSnapshotResult =
  | { status: "stored"; storedAt: Date; sizeBytes: number }
  | { status: "generation-conflict"; actualGeneration: number }
  | { status: "room-missing" }
  | { status: "seed-owner-conflict" };

type SnapshotStoreDecisionInput = {
  actualGeneration: number;
  expectedGeneration: number;
  seedClaimedBy: string | null;
  seedState: "claimed" | "empty" | "seeded";
  userId: string;
};

export const decideFolioCollabSnapshotStore = ({
  actualGeneration,
  expectedGeneration,
  seedClaimedBy,
  seedState,
  userId,
}: SnapshotStoreDecisionInput):
  | { status: "accepted" }
  | { status: "generation-conflict"; actualGeneration: number }
  | { status: "seed-owner-conflict" } => {
  if (actualGeneration !== expectedGeneration) {
    return { status: "generation-conflict", actualGeneration };
  }
  if (seedState === "empty") {
    return { status: "seed-owner-conflict" };
  }
  if (seedState === "claimed" && seedClaimedBy !== userId) {
    return { status: "seed-owner-conflict" };
  }
  return { status: "accepted" };
};

export const storeFolioCollabSnapshot = async ({
  expectedGeneration,
  snapshotBytes,
  value,
}: {
  expectedGeneration: number;
  snapshotBytes: Uint8Array;
  value: AuthorizedFolioCollabRoom;
}): Promise<StoreFolioCollabSnapshotResult> => {
  const nextSnapshotFileId = createSafeId<"userFile">();
  const nextKey = createFileKey({
    fileId: nextSnapshotFileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
  });
  await writeS3ObjectWithRetry({
    contentType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    data: snapshotBytes,
    key: nextKey,
  });

  const discardNewObject = async () =>
    await deleteStoredRoomFile({
      file: {
        fileId: nextSnapshotFileId,
        mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
      },
      organizationId: value.organizationId,
      roomId: value.roomId,
      workspaceId: value.workspaceId,
    });

  const storedAt = new Date();
  const transactionResult = await Result.tryPromise({
    try: async () =>
      await value.scopedDb(async (tx) => {
        const rooms = await tx
          .select({
            generation: folioCollabRooms.generation,
            seedClaimedBy: folioCollabRooms.seedClaimedBy,
            seedState: folioCollabRooms.seedState,
            yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
            yjsSnapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
          })
          .from(folioCollabRooms)
          .where(
            and(
              eq(folioCollabRooms.id, value.roomId),
              eq(folioCollabRooms.workspaceId, value.workspaceId),
            ),
          )
          .limit(1)
          .for("update");

        const room = rooms.at(0);
        if (!room) {
          return { status: "room-missing" } as const;
        }
        const decision = decideFolioCollabSnapshotStore({
          actualGeneration: room.generation,
          expectedGeneration,
          seedClaimedBy: room.seedClaimedBy,
          seedState: room.seedState,
          userId: value.userId,
        });
        if (decision.status !== "accepted") {
          return decision;
        }

        const updated = await tx
          .update(folioCollabRooms)
          .set(
            room.seedState === "claimed"
              ? {
                  lastActivityAt: storedAt,
                  seededAt: storedAt,
                  seedState: "seeded",
                  yjsSnapshotFileId: nextSnapshotFileId,
                  yjsSnapshotSizeBytes: snapshotBytes.byteLength,
                  yjsSnapshotUpdatedAt: storedAt,
                }
              : {
                  lastActivityAt: storedAt,
                  seedState: "seeded",
                  yjsSnapshotFileId: nextSnapshotFileId,
                  yjsSnapshotSizeBytes: snapshotBytes.byteLength,
                  yjsSnapshotUpdatedAt: storedAt,
                },
          )
          .where(
            and(
              eq(folioCollabRooms.id, value.roomId),
              eq(folioCollabRooms.workspaceId, value.workspaceId),
              eq(folioCollabRooms.generation, expectedGeneration),
            ),
          )
          .returning({ id: folioCollabRooms.id });

        if (!updated.at(0)) {
          return {
            status: "generation-conflict",
            actualGeneration: room.generation,
          } as const;
        }

        if (room.yjsSnapshotUpdatedAt !== null) {
          const previousKey = createFileKey({
            fileId: room.yjsSnapshotFileId,
            mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
            organizationId: value.organizationId,
            workspaceId: value.workspaceId,
          });
          // audit: skip; this is bounded storage-cleanup bookkeeping for an
          // immutable snapshot superseded by the room update in this transaction.
          await tx.insert(bufferObjectCleanupIntents).values({
            id: createSafeId<"pendingUpload">(),
            nextAttemptAt: new Date(
              storedAt.getTime() + FOLIO_COLLAB_SNAPSHOT_CLEANUP_GRACE_MS,
            ),
            objectKey: previousKey,
            organizationId: value.organizationId,
            workspaceId: value.workspaceId,
          });
        }

        return {
          status: "stored",
        } as const;
      }),
    catch: (cause) => cause,
  });

  if (Result.isError(transactionResult)) {
    await discardNewObject();
    throw transactionResult.error;
  }

  const result = transactionResult.value;

  if (result.status !== "stored") {
    await discardNewObject();
    return result;
  }

  return {
    status: "stored",
    storedAt,
    sizeBytes: snapshotBytes.byteLength,
  };
};
