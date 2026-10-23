import { panic, Result, TaggedError } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { FolioCollabSnapshotLoadResponse } from "@stll/api-contract/folio-collab";
import { roles } from "@stll/permissions";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { abortableTx, safeDbFromScoped } from "@/api/db/safe-db";
import type { FolioCollabTokenPermissions } from "@/api/db/schema";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  desktopEditSessions,
  entityVersions,
  folioCollabContributions,
  folioCollabRooms,
  folioCollabRoomTokens,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockActiveWorkspaceForBufferIntent,
  lockObjectCleanupIntentsForWriter,
  lockOrganizationObjectIntentsForWriter,
  OBJECT_WRITE_RECOVERY_DELAY_MS,
  objectWriterSettlementAfterCleanup,
  retirePublishedObjectCleanupIntentsInTransaction,
  settleObjectCleanupIntentsAfterWriterInTransaction,
} from "@/api/lib/buffer-intent-reconciliation";
import {
  withAggregateLock,
  withAggregateRowQuery,
} from "@/api/lib/db/aggregate-lock";
import { FOLIO_COLLAB_SEED_TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import { createOpaqueToken } from "@/api/lib/entities/opaque-tokens";
import { lockDocxEditTarget } from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { deleteOrganizationFileWithSignal } from "@/api/lib/files/delete-organization-file";
import {
  decideFolioSnapshotRecoveryState,
  FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME,
  loadPersistedFolioSnapshot,
} from "@/api/lib/files/folio-collab-snapshot-loader";
import { retireFolioCollabSnapshot } from "@/api/lib/files/folio-collab-snapshot-retirement";
import { writeOrganizationFile } from "@/api/lib/files/organization-file-usage";
import type { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { createFileKey } from "@/api/lib/files/utils";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import {
  FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT,
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  FOLIO_COLLAB_TOKEN_TTL_MS,
} from "@/api/lib/folio-collab-room-contract";
import { isMemberRole } from "@/api/lib/member-roles";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  readS3ObjectIfPresent,
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { isSyntheticPrincipal } from "@/api/lib/synthetic-principal/constants";
import { requireSessionCredentialAuthority } from "@/api/lib/synthetic-principal/credential-policy";
import type { SyntheticSessionAuthorityReader } from "@/api/lib/synthetic-principal/session-authority";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const FOLIO_COLLAB_TOKEN_CLEANUP_BATCH_SIZE = 100;
const FOLIO_COLLAB_SNAPSHOT_CLEANUP_GRACE_MS = 60_000;
const FOLIO_COLLAB_S3_DELETE_TIMEOUT_MS = 10_000;

export {
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  FOLIO_COLLAB_TOKEN_TTL_MS,
  FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
};

const hashFolioCollabToken = (token: string) => hashSha256Hex(token);

export const computeFolioCollabTokenExpiresAt = (now = new Date()) =>
  new Date(now.getTime() + FOLIO_COLLAB_TOKEN_TTL_MS);

type FolioCollabStoredRoomFile = {
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
  sourceSessionExpiresAt: Date | null;
  tokenId: SafeId<"folioCollabRoomToken">;
  userId: SafeId<"user">;
  userName: string;
  workspaceId: SafeId<"workspace">;
};

export type FolioCollabSnapshotTarget = Pick<
  AuthorizedFolioCollabRoom,
  "organizationId" | "roomId" | "scopedDb" | "workspaceId"
>;

type FolioCollabSnapshotStoreAuthority =
  { type: "collab-service" } | { type: "participant"; userId: SafeId<"user"> };

type FolioCollabTokenIssueDb = {
  execute: (query: SQL) => Promise<unknown>;
  insert: (table: typeof folioCollabRoomTokens) => {
    values: (
      row: typeof folioCollabRoomTokens.$inferInsert,
    ) => PromiseLike<unknown>;
  };
};

type IssueFolioCollabTokenOptions = {
  sourceSessionId: string | null;
  readSessionAuthority: SyntheticSessionAuthorityReader;
  generation: number;
  permissions: FolioCollabTokenPermissions;
  roomId: SafeId<"folioCollabRoom">;
  tx: FolioCollabTokenIssueDb;
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
  sourceSessionId,
  readSessionAuthority,
  generation,
  permissions,
  roomId,
  tx,
  userId,
  workspaceId,
}: IssueFolioCollabTokenOptions) => {
  const token = createOpaqueToken();
  const now = new Date();
  const authority = isSyntheticPrincipal({ userId })
    ? requireSessionCredentialAuthority(
        await readSessionAuthority({
          sessionId: sourceSessionId,
          userId,
          now,
        }),
      )
    : null;
  const tokenExpiresAt = authority
    ? new Date(
        Math.min(
          computeFolioCollabTokenExpiresAt(now).getTime(),
          authority.expiresAt.getTime(),
        ),
      )
    : computeFolioCollabTokenExpiresAt(now);
  await cleanupExpiredFolioCollabRoomTokens({ db: tx, workspaceId });
  await tx.insert(folioCollabRoomTokens).values({
    expiresAt: tokenExpiresAt,
    sourceSessionId: authority?.sessionId ?? null,
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

export const recordFolioCollabContribution = async ({
  roomId,
  tx,
  userId,
  workspaceId,
}: {
  roomId: SafeId<"folioCollabRoom">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}) => {
  const recordedAt = new Date();
  const rooms = await tx
    .select({
      baseVersionId: folioCollabRooms.baseVersionId,
      entityId: folioCollabRooms.entityId,
    })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.id, roomId),
        eq(folioCollabRooms.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("update");
  const room = rooms.at(0);
  if (!room) {
    return false;
  }

  const refreshed = await tx
    .update(folioCollabContributions)
    .set({ updatedAt: recordedAt })
    .where(
      and(
        eq(folioCollabContributions.roomId, roomId),
        eq(folioCollabContributions.userId, userId),
      ),
    )
    .returning({ id: folioCollabContributions.id });
  if (refreshed.at(0)) {
    return true;
  }

  const contributionCount = await tx.$count(
    folioCollabContributions,
    and(
      eq(folioCollabContributions.roomId, roomId),
      eq(folioCollabContributions.workspaceId, workspaceId),
    ),
  );
  if (contributionCount >= FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT) {
    return false;
  }

  await tx
    .insert(folioCollabContributions)
    .values({
      entityId: room.entityId,
      id: createSafeId<"folioCollabContribution">(),
      roomId,
      sinceVersionId: room.baseVersionId,
      userId,
      workspaceId,
    })
    .onConflictDoNothing({
      target: [
        folioCollabContributions.roomId,
        folioCollabContributions.userId,
      ],
    });
  return true;
};

export const refreshFolioCollabToken = async ({
  tokenId,
  sourceSessionExpiresAt,
  tx,
}: {
  tokenId: SafeId<"folioCollabRoomToken">;
  sourceSessionExpiresAt: Date | null;
  tx: Transaction;
}) => {
  const nextExpiry = computeFolioCollabTokenExpiresAt();
  const tokenExpiresAt = sourceSessionExpiresAt
    ? new Date(Math.min(nextExpiry.getTime(), sourceSessionExpiresAt.getTime()))
    : nextExpiry;
  if (tokenExpiresAt <= new Date()) {
    return null;
  }
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
  /** The database access rule's answer for the token's user. */
  reachesMatter: boolean;
  workspaceStatus: (typeof workspaces.$inferSelect)["status"];
};

export const canUseFolioCollabWorkspace = ({
  organizationRole,
  reachesMatter,
}: Pick<FolioCollabRoomDecisionInput, "organizationRole" | "reachesMatter">) =>
  reachesMatter && organizationRole !== null && isMemberRole(organizationRole);

export const decideFolioCollabRoomAuthorization = ({
  actualGeneration,
  expiresAt,
  now,
  organizationRole,
  tokenCanEdit,
  tokenGeneration,
  reachesMatter,
  workspaceStatus,
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

  if (workspaceStatus !== "active") {
    return { status: "workspace-access-revoked" };
  }

  const role = organizationRole;
  const canUseWorkspace = canUseFolioCollabWorkspace({
    organizationRole: role,
    reachesMatter,
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
  db = rootDb,
  createScopedDb = createRootScopedDb,
  readSessionAuthority,
}: {
  db?: Pick<typeof rootDb, "select">;
  createScopedDb?: typeof createRootScopedDb;
  readSessionAuthority: SyntheticSessionAuthorityReader;
  roomId: SafeId<"folioCollabRoom">;
  token: string;
}): Promise<FolioCollabRoomAuthorizationResult> => {
  const tokenHash = hashFolioCollabToken(token);

  // The token hash is the only trusted lookup key before its tenant is known.
  // This owner-level read derives one workspace, then every subsequent room
  // operation uses the scoped database capability returned below.
  const rows = await db
    .select({
      entityId: folioCollabRooms.entityId,
      expiresAt: folioCollabRoomTokens.expiresAt,
      fileName: folioCollabRooms.fileName,
      generation: folioCollabRooms.generation,
      organizationId: workspaces.organizationId,
      organizationRole: member.role,
      permissions: folioCollabRoomTokens.permissions,
      propertyId: folioCollabRooms.propertyId,
      sourceSessionId: folioCollabRoomTokens.sourceSessionId,
      tokenId: folioCollabRoomTokens.id,
      tokenGeneration: folioCollabRoomTokens.generation,
      userId: folioCollabRoomTokens.userId,
      userName: user.name,
      workspaceId: folioCollabRooms.workspaceId,
      reachesMatter: memberReachesMatterSql(
        {
          organizationId: workspaces.organizationId,
          userId: folioCollabRoomTokens.userId,
        },
        folioCollabRooms.workspaceId,
      ),
      workspaceStatus: workspaces.status,
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
    .innerJoin(user, eq(user.id, folioCollabRoomTokens.userId))
    .leftJoin(
      member,
      and(
        eq(member.userId, folioCollabRoomTokens.userId),
        eq(member.organizationId, workspaces.organizationId),
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

  const synthetic = isSyntheticPrincipal({ userId: row.userId });
  const authority = synthetic
    ? await readSessionAuthority({
        sessionId: row.sourceSessionId,
        userId: row.userId,
      })
    : null;
  if (synthetic && !authority) {
    return { status: "token-expired" };
  }
  const tokenExpiresAt = authority
    ? new Date(Math.min(row.expiresAt.getTime(), authority.expiresAt.getTime()))
    : row.expiresAt;
  const decision = decideFolioCollabRoomAuthorization({
    actualGeneration: row.generation,
    expiresAt: tokenExpiresAt,
    now: new Date(),
    organizationRole: row.organizationRole,
    tokenCanEdit: row.permissions.canEdit,
    tokenGeneration: row.tokenGeneration,
    reachesMatter: row.reachesMatter,
    workspaceStatus: row.workspaceStatus,
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
      scopedDb: createScopedDb({
        organizationId: row.organizationId,
        userId: brandPersistedUserId(row.userId),
        workspaceIds: [row.workspaceId],
      }),
      tokenExpiresAt,
      sourceSessionExpiresAt: authority?.expiresAt ?? null,
      tokenId: row.tokenId,
      userId: brandPersistedUserId(row.userId),
      userName: row.userName,
      workspaceId: row.workspaceId,
    },
  };
};

type TouchFolioCollabRoomResult =
  | { status: "active"; activeAt: Date }
  | { status: "desktop-conflict" }
  | { status: "room-missing" }
  | { status: "workspace-inactive" };

export const folioCollabSeedClaimLeaseOnHeartbeat = ({
  touchedAt,
  userId,
}: {
  touchedAt: Date;
  userId: SafeId<"user">;
}) => sql`CASE
  WHEN ${folioCollabRooms.seedState} = 'claimed'
    AND ${folioCollabRooms.seedClaimedBy} = ${userId}
  THEN ${touchedAt}
  ELSE ${folioCollabRooms.seedClaimedAt}
END`;

export const touchFolioCollabRoom = async (
  value: AuthorizedFolioCollabRoom,
): Promise<TouchFolioCollabRoomResult> => {
  const touchedAt = new Date();
  return await value.scopedDb(async (tx) => {
    await withAggregateLock({
      aggregate: "workspace",
      id: { id: value.workspaceId, organizationId: value.organizationId },
      mode: "update",
      tx,
    });
    const workspaceRows = await tx
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, value.workspaceId))
      .limit(1)
      .for("update");
    if (workspaceRows.at(0)?.status !== "active") {
      return {
        status: "workspace-inactive",
      } satisfies TouchFolioCollabRoomResult;
    }

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
      .set({
        lastActivityAt: touchedAt,
        seedClaimedAt: folioCollabSeedClaimLeaseOnHeartbeat({
          touchedAt,
          userId: value.userId,
        }),
      })
      .where(
        and(
          eq(folioCollabRooms.id, value.roomId),
          eq(folioCollabRooms.workspaceId, value.workspaceId),
        ),
      )
      .returning({ id: folioCollabRooms.id });

    if (!updated.at(0)) {
      return { status: "room-missing" } satisfies TouchFolioCollabRoomResult;
    }
    await recordFolioCollabContribution({
      roomId: value.roomId,
      tx,
      userId: value.userId,
      workspaceId: value.workspaceId,
    });
    return {
      status: "active",
      activeAt: touchedAt,
    } satisfies TouchFolioCollabRoomResult;
  });
};

type FolioCollabSnapshotLoadResult = Result<
  {
    snapshot: FolioCollabSnapshotLoadResponse;
    rawSnapshotSha256Hex: string | null;
  } | null,
  HandlerError
>;

type SnapshotRecoveryPointer = Pick<
  typeof folioCollabRooms.$inferSelect,
  | "baseVersionId"
  | "generation"
  | "seededAt"
  | "savedSnapshotCut"
  | "sourceVersionId"
  | "docxCheckpointFileId"
  | "docxCheckpointUpdatedAt"
  | "yjsSnapshotFileId"
  | "yjsSnapshotRevision"
  | "yjsSnapshotUpdatedAt"
> & { savedVersionCreatedAt: Date };

type RecoverRefusedFolioSnapshotOptions = {
  value: FolioCollabSnapshotTarget;
  snapshotPointer: SnapshotRecoveryPointer;
  snapshotSha256Hex: string;
};

const recoverRefusedFolioSnapshot = async ({
  value,
  snapshotPointer,
  snapshotSha256Hex,
}: RecoverRefusedFolioSnapshotOptions) => {
  const recovered = await value.scopedDb(async (tx) => {
    await withAggregateLock({
      aggregate: "workspace",
      id: { id: value.workspaceId, organizationId: value.organizationId },
      mode: "update",
      tx,
    });
    const generation = snapshotPointer.generation + 1;
    const changed = await transitionScopedCount({
      tx,
      spec: FOLIO_COLLAB_SEED_TRANSITIONS,
      where:
        and(
          eq(folioCollabRooms.id, value.roomId),
          eq(folioCollabRooms.workspaceId, value.workspaceId),
          eq(folioCollabRooms.generation, snapshotPointer.generation),
          eq(folioCollabRooms.baseVersionId, snapshotPointer.baseVersionId),
          eq(
            folioCollabRooms.docxCheckpointFileId,
            snapshotPointer.docxCheckpointFileId,
          ),
          snapshotPointer.savedSnapshotCut === null
            ? isNull(folioCollabRooms.savedSnapshotCut)
            : eq(
                folioCollabRooms.savedSnapshotCut,
                snapshotPointer.savedSnapshotCut,
              ),
          eq(
            folioCollabRooms.yjsSnapshotFileId,
            snapshotPointer.yjsSnapshotFileId,
          ),
          eq(
            folioCollabRooms.yjsSnapshotRevision,
            snapshotPointer.yjsSnapshotRevision,
          ),
        ) ?? panic("Snapshot recovery requires a room predicate"),
      options: {
        from: ["empty", "claimed", "seeded"],
        to: "empty",
        set: {
          generation,
          updatedAt: new Date(),
          seedClaimedAt: null,
          seedClaimedBy: null,
          seededAt: null,
          sourceVersionId: snapshotPointer.baseVersionId,
          docxCheckpointFileId: createSafeId<"userFile">(),
          docxCheckpointSha256Hex: null,
          docxCheckpointSnapshotSha256Hex: null,
          docxCheckpointSizeBytes: null,
          docxCheckpointScanWarnings: null,
          docxCheckpointUpdatedAt: null,
          ...retireFolioCollabSnapshot({
            snapshotFileId: createSafeId<"userFile">(),
            now: new Date(),
            state: decideFolioSnapshotRecoveryState({
              snapshotSha256Hex,
              savedSnapshotCut: snapshotPointer.savedSnapshotCut,
              savedVersionId: snapshotPointer.baseVersionId,
              snapshotUpdatedAt: snapshotPointer.yjsSnapshotUpdatedAt,
              savedVersionCreatedAt: snapshotPointer.savedVersionCreatedAt,
              seededAt: snapshotPointer.seededAt,
              historicalBaseline:
                snapshotPointer.sourceVersionId ===
                snapshotPointer.baseVersionId
                  ? "initial-seed"
                  : "publication",
            }),
          }),
        },
      },
      recordTransitionAuditEvent: async (auditTx) => {
        const retiredKeys = [
          createFileKey({
            fileId: snapshotPointer.yjsSnapshotFileId,
            mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
            organizationId: value.organizationId,
            workspaceId: value.workspaceId,
          }),
        ];
        if (snapshotPointer.docxCheckpointUpdatedAt !== null) {
          retiredKeys.push(
            createFileKey({
              fileId: snapshotPointer.docxCheckpointFileId,
              mimeType: DOCX_MIME_TYPE,
              organizationId: value.organizationId,
              workspaceId: value.workspaceId,
            }),
          );
        }
        await auditTx.insert(bufferObjectCleanupIntents).values(
          retiredKeys.map((objectKey) => ({
            id: createSafeId<"pendingUpload">(),
            nextAttemptAt: new Date(
              Temporal.Now.instant().epochMilliseconds +
                FOLIO_COLLAB_SNAPSHOT_CLEANUP_GRACE_MS,
            ),
            objectKey,
            organizationId: value.organizationId,
            status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
            workspaceId: value.workspaceId,
          })),
        );
        const actor = TENANT_SYSTEM_ACTOR.folioCollaborationRecovery;
        const recordAuditEvent = createBackgroundAuditRecorder({
          organizationId: value.organizationId,
          workspaceId: value.workspaceId,
          userId: actor,
          execution: {
            performer: {
              type: "service",
              id: actor,
              name: "Collaboration recovery",
            },
            trigger: { type: "system", source: actor },
          },
        });
        await recordAuditEvent(auditTx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
          resourceId: value.roomId,
          changes: {
            generation: {
              old: snapshotPointer.generation,
              new: generation,
            },
          },
          metadata: {
            kind: "snapshot-rematerialization",
            snapshotRevision: snapshotPointer.yjsSnapshotRevision,
          },
        });
      },
    });
    if (changed === 0) {
      return null;
    }
    return { generation };
  });
  if (recovered !== null) {
    return {
      status: "reset",
      generation: recovered.generation,
      resetGeneration: snapshotPointer.generation,
    } as const;
  }
  return { status: "replaced" } as const;
};

export const loadFolioCollabSnapshot = async (
  value: FolioCollabSnapshotTarget,
  readObject = readS3ObjectIfPresent,
) => {
  const readPointer = async () => {
    const rooms = await value.scopedDb(async (tx) =>
      tx
        .select({
          baseVersionId: folioCollabRooms.baseVersionId,
          generation: folioCollabRooms.generation,
          savedVersionCreatedAt: entityVersions.createdAt,
          sourceVersionId: folioCollabRooms.sourceVersionId,
          docxCheckpointFileId: folioCollabRooms.docxCheckpointFileId,
          docxCheckpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
          savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
          seededAt: folioCollabRooms.seededAt,
          yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
          yjsSnapshotRevision: folioCollabRooms.yjsSnapshotRevision,
          yjsSnapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabRooms)
        .innerJoin(
          entityVersions,
          and(
            eq(entityVersions.id, folioCollabRooms.baseVersionId),
            eq(entityVersions.workspaceId, folioCollabRooms.workspaceId),
          ),
        )
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

  const loadCurrentSnapshot = async (
    attempt: "initial" | "replacement",
  ): Promise<FolioCollabSnapshotLoadResult> => {
    let room = await readPointer();
    if (!room) {
      return Result.ok(null);
    }
    if (!room.yjsSnapshotUpdatedAt) {
      return Result.ok({
        snapshot: {
          generation: room.generation,
          loadOutcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded,
          snapshotBase64: null,
          snapshotRevision: room.yjsSnapshotRevision,
        },
        rawSnapshotSha256Hex: null,
      });
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
        return Result.ok(null);
      }
      if (!room.yjsSnapshotUpdatedAt) {
        return Result.ok({
          snapshot: {
            generation: room.generation,
            loadOutcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded,
            snapshotBase64: null,
            snapshotRevision: room.yjsSnapshotRevision,
          },
          rawSnapshotSha256Hex: null,
        });
      }
      if (room.yjsSnapshotFileId === previousFileId) {
        return panic("Current collaboration snapshot object is missing");
      }
      buffer = await readSnapshot(room.yjsSnapshotFileId);
      if (buffer === null) {
        return panic("Replacement collaboration snapshot object is missing");
      }
    }

    const snapshotPointer = room;
    const snapshotBytes = new Uint8Array(buffer);
    const loadedResult = await loadPersistedFolioSnapshot({
      snapshotBytes,
      onRefused: async () =>
        await recoverRefusedFolioSnapshot({
          value,
          snapshotPointer,
          snapshotSha256Hex: hashSha256Hex(snapshotBytes),
        }),
    });

    if (Result.isError(loadedResult)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Collaborative snapshot could not be loaded.",
          cause: loadedResult.error,
        }),
      );
    }
    const loaded = loadedResult.value;
    switch (loaded.outcome) {
      case FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded:
        return Result.ok({
          snapshot: {
            generation: room.generation,
            loadOutcome: loaded.outcome,
            snapshotBase64: Buffer.from(loaded.snapshotBytes).toString(
              "base64",
            ),
            snapshotRevision: room.yjsSnapshotRevision,
          },
          rawSnapshotSha256Hex: hashSha256Hex(snapshotBytes),
        });
      case FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.rematerializeFromDocx:
        return Result.ok({
          snapshot: {
            generation: loaded.generation,
            resetGeneration: loaded.resetGeneration,
            loadOutcome: loaded.outcome,
            snapshotBase64: null,
            snapshotRevision: 0,
          },
          rawSnapshotSha256Hex: null,
        });
      case "reload-current": {
        if (attempt === "initial") {
          return await loadCurrentSnapshot("replacement");
        }
        const error = new HandlerError({
          status: 503,
          code: "folio_collab_snapshot_recovery_conflict",
          retryable: true,
          message: "Collaborative snapshot changed during recovery.",
        });
        return Result.err(error);
      }
      default: {
        loaded satisfies never;
        return panic("Unhandled snapshot load outcome");
      }
    }
  };
  return await loadCurrentSnapshot("initial");
};

export type StoreFolioCollabSnapshotResult =
  | {
      status: "stored";
      snapshotRevision: number;
      storedAt: Date;
      sizeBytes: number;
    }
  | { status: "generation-conflict"; actualGeneration: number }
  | { status: "snapshot-revision-conflict"; actualSnapshotRevision: number }
  | { status: "room-missing" }
  | { status: "seed-owner-conflict" }
  | { status: "workspace-inactive" };

type SnapshotStoreDecisionInput = {
  actualGeneration: number;
  authority: FolioCollabSnapshotStoreAuthority;
  expectedGeneration: number;
  expectedSnapshotRevision: number;
  actualSnapshotRevision: number;
  seedClaimedBy: string | null;
  seedState: "claimed" | "empty" | "seeded";
};

export const decideFolioCollabSnapshotStore = ({
  actualGeneration,
  actualSnapshotRevision,
  authority,
  expectedGeneration,
  expectedSnapshotRevision,
  seedClaimedBy,
  seedState,
}: SnapshotStoreDecisionInput):
  | { status: "accepted" }
  | { status: "generation-conflict"; actualGeneration: number }
  | { status: "snapshot-revision-conflict"; actualSnapshotRevision: number }
  | { status: "seed-owner-conflict" } => {
  if (actualGeneration !== expectedGeneration) {
    return { status: "generation-conflict", actualGeneration };
  }
  if (actualSnapshotRevision !== expectedSnapshotRevision) {
    return { status: "snapshot-revision-conflict", actualSnapshotRevision };
  }
  if (seedState === "empty") {
    return { status: "seed-owner-conflict" };
  }
  if (
    seedState === "claimed" &&
    authority.type === "participant" &&
    seedClaimedBy !== authority.userId
  ) {
    return { status: "seed-owner-conflict" };
  }
  return { status: "accepted" };
};

class FolioCollabSnapshotStoreError extends TaggedError(
  "FolioCollabSnapshotStoreError",
)<{
  message: string;
  cause: unknown;
}> {}

const snapshotStoreFailure = (cause: unknown) =>
  new FolioCollabSnapshotStoreError({
    message: "Collaborative snapshot could not be stored.",
    cause,
  });

export const storeFolioCollabSnapshot = async ({
  authority,
  expectedGeneration,
  expectedSnapshotRevision,
  snapshotBytes,
  value,
}: {
  authority: FolioCollabSnapshotStoreAuthority;
  expectedGeneration: number;
  expectedSnapshotRevision: number;
  snapshotBytes: Uint8Array;
  value: FolioCollabSnapshotTarget;
}): Promise<
  Result<
    StoreFolioCollabSnapshotResult,
    FolioCollabSnapshotStoreError | OrganizationFileUsageError
  >
> => {
  const nextSnapshotFileId = createSafeId<"userFile">();
  const nextCleanupIntentId = createSafeId<"pendingUpload">();
  const nextKey = createFileKey({
    fileId: nextSnapshotFileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
  });
  const reserved = await Result.tryPromise({
    try: async () =>
      await value.scopedDb(async (tx) => {
        await lockOrganizationObjectIntentsForWriter(tx, value.organizationId);
        await lockActiveWorkspaceForBufferIntent({
          tx,
          workspaceId: value.workspaceId,
          mode: "share",
        });
        // Reserve cleanup ownership before the object can exist. A process crash
        // after PUT therefore leaves a durable exact-key tombstone for recovery.
        await tx.insert(bufferObjectCleanupIntents).values({
          id: nextCleanupIntentId,
          nextAttemptAt: new Date(
            Temporal.Now.instant().epochMilliseconds +
              OBJECT_WRITE_RECOVERY_DELAY_MS,
          ),
          objectKey: nextKey,
          organizationId: value.organizationId,
          status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
          workspaceId: value.workspaceId,
        });
      }),
    catch: snapshotStoreFailure,
  });
  if (Result.isError(reserved)) {
    return Result.err(reserved.error);
  }
  const discardNewObject = async (
    writeCertainty: S3ObjectWriteCertainty,
  ): Promise<void> => {
    const cleanup = Result.flatten(
      await Result.tryPromise({
        try: async () =>
          await deleteOrganizationFileWithSignal(
            nextKey,
            AbortSignal.timeout(FOLIO_COLLAB_S3_DELETE_TIMEOUT_MS),
          ),
        catch: (cause) => cause,
      }),
    );
    if (Result.isError(cleanup)) {
      captureError(
        cleanup.error,
        handlerErrorContext("lib.discardNewObject.cleanup_error", {
          roomId: value.roomId,
          storageKey: nextKey,
        }),
      );
    }
    await value
      .scopedDb(
        async (tx) =>
          await settleObjectCleanupIntentsAfterWriterInTransaction({
            intentIds: [nextCleanupIntentId],
            objectState: objectWriterSettlementAfterCleanup({
              cleanupSucceeded: Result.isOk(cleanup),
              writeState: writeCertainty,
            }),
            tx,
          }),
      )
      .catch((error: unknown) => {
        captureError(
          error,
          handlerErrorContext("lib.discardNewObject", {
            roomId: value.roomId,
            storageKey: nextKey,
          }),
        );
      });
  };
  const written = Result.flatten(
    await Result.tryPromise({
      try: async () => {
        if (!isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
          return Result.ok(
            await writeS3ObjectWithRetry(
              {
                contentType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
                data: snapshotBytes,
                key: nextKey,
              },
              { type: "cleanup-intent", intent: nextCleanupIntentId },
            ),
          );
        }
        return await writeOrganizationFile({
          organizationId: value.organizationId,
          objectKey: nextKey,
          sizeBytes: snapshotBytes.byteLength,
          content: snapshotBytes,
          write: async ({ content, objectKey }) =>
            await writeS3ObjectWithRetry(
              {
                contentType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
                data: content,
                key: objectKey,
              },
              { type: "cleanup-intent", intent: nextCleanupIntentId },
            ),
        });
      },
      catch: snapshotStoreFailure,
    }),
  );
  if (Result.isError(written)) {
    await discardNewObject(S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN);
    return Result.err(written.error);
  }
  const writeCertainty = written.value;

  const storedAt = new Date();
  const transactionResult = await Result.tryPromise({
    try: async () =>
      await value.scopedDb(async (tx) => {
        const { rows: workspaceRows } = await withAggregateRowQuery({
          aggregate: "workspace",
          id: { id: value.workspaceId, organizationId: value.organizationId },
          mode: "update",
          tx,
          select: (lockTx) =>
            lockTx
              .select({
                id: workspaces.id,
                organizationId: workspaces.organizationId,
                status: workspaces.status,
              })
              .from(workspaces),
        });
        if (workspaceRows.at(0)?.status !== "active") {
          return { status: "workspace-inactive" } as const;
        }

        const { rows: rooms } = await withAggregateRowQuery({
          aggregate: "folioCollabRoom",
          id: { id: value.roomId, workspaceId: value.workspaceId },
          mode: "update",
          tx,
          select: (lockTx) =>
            lockTx
              .select({
                id: folioCollabRooms.id,
                workspaceId: folioCollabRooms.workspaceId,
                generation: folioCollabRooms.generation,
                baseVersionId: folioCollabRooms.baseVersionId,
                seedClaimedBy: folioCollabRooms.seedClaimedBy,
                savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
                seedState: folioCollabRooms.seedState,
                yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
                yjsSnapshotRevision: folioCollabRooms.yjsSnapshotRevision,
                yjsSnapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
              })
              .from(folioCollabRooms),
        });

        const room = rooms.at(0);
        if (!room) {
          return { status: "room-missing" } as const;
        }
        const decision = decideFolioCollabSnapshotStore({
          actualGeneration: room.generation,
          actualSnapshotRevision: room.yjsSnapshotRevision,
          authority,
          expectedGeneration,
          expectedSnapshotRevision,
          seedClaimedBy: room.seedClaimedBy,
          seedState: room.seedState,
        });
        if (decision.status !== "accepted") {
          return decision;
        }
        await lockObjectCleanupIntentsForWriter(tx, [nextCleanupIntentId]);

        let seedTransition: Pick<
          typeof folioCollabRooms.$inferInsert,
          "seedState" | "seededAt"
        >;
        if (room.seedState !== "claimed") {
          seedTransition = { seedState: "seeded" };
        } else if (room.savedSnapshotCut?.versionId === room.baseVersionId) {
          seedTransition = { seedState: "seeded", seededAt: storedAt };
        } else {
          seedTransition = { seedState: "claimed", seededAt: null };
        }
        const updated = await tx
          .update(folioCollabRooms)
          .set({
            lastActivityAt: storedAt,
            snapshotRecoveredAt: null,
            yjsSnapshotFileId: nextSnapshotFileId,
            yjsSnapshotRevision: room.yjsSnapshotRevision + 1,
            yjsSnapshotSizeBytes: snapshotBytes.byteLength,
            yjsSnapshotUpdatedAt: storedAt,
            ...seedTransition,
          })
          .where(
            and(
              eq(folioCollabRooms.id, value.roomId),
              eq(folioCollabRooms.workspaceId, value.workspaceId),
              eq(folioCollabRooms.generation, expectedGeneration),
              eq(
                folioCollabRooms.yjsSnapshotRevision,
                expectedSnapshotRevision,
              ),
            ),
          )
          .returning({
            snapshotRevision: folioCollabRooms.yjsSnapshotRevision,
          });

        const updatedRoom = updated.at(0);
        if (!updatedRoom) {
          if (room.generation !== expectedGeneration) {
            return {
              status: "generation-conflict",
              actualGeneration: room.generation,
            } satisfies StoreFolioCollabSnapshotResult;
          }
          return {
            status: "snapshot-revision-conflict",
            actualSnapshotRevision: room.yjsSnapshotRevision,
          } satisfies StoreFolioCollabSnapshotResult;
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
            status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
            workspaceId: value.workspaceId,
          });
        }

        // The room pointer now owns this immutable object. Retire the crash
        // recovery tombstone in the same transaction that published it.
        await retirePublishedObjectCleanupIntentsInTransaction({
          intentIds: [nextCleanupIntentId],
          tx,
        });

        return {
          snapshotRevision: updatedRoom.snapshotRevision,
          status: "stored",
        } as const;
      }),
    catch: snapshotStoreFailure,
  });

  if (Result.isError(transactionResult)) {
    await discardNewObject(writeCertainty);
    return Result.err(transactionResult.error);
  }

  const result = transactionResult.value;

  if (result.status !== "stored") {
    await discardNewObject(writeCertainty);
    return Result.ok(result);
  }

  return Result.ok({
    status: "stored",
    snapshotRevision: result.snapshotRevision,
    storedAt,
    sizeBytes: snapshotBytes.byteLength,
  });
};

type AcknowledgeFolioCollabSeedOptions = {
  snapshotSha256Hex: string;
  value: AuthorizedFolioCollabRoom;
};

/** Records only the immutable pre-edit seed cut captured by the seed claimant. */
export const acknowledgeFolioCollabSeed = async ({
  snapshotSha256Hex,
  value,
}: AcknowledgeFolioCollabSeedOptions) => {
  if (!value.canEdit) {
    return Result.ok({ status: "access-revoked" } as const);
  }
  return await abortableTx(safeDbFromScoped(value.scopedDb), async (tx) => {
    await withAggregateLock({
      aggregate: "workspace",
      id: { id: value.workspaceId, organizationId: value.organizationId },
      mode: "update",
      tx,
    });
    const { rows: rooms } = await withAggregateRowQuery({
      aggregate: "folioCollabRoom",
      id: { id: value.roomId, workspaceId: value.workspaceId },
      mode: "update",
      tx,
      lockConfig: { of: folioCollabRooms },
      select: (lockTx) =>
        lockTx
          .select({
            id: folioCollabRooms.id,
            workspaceId: folioCollabRooms.workspaceId,
            generation: folioCollabRooms.generation,
            baseVersionId: folioCollabRooms.baseVersionId,
            savedSnapshotCut: folioCollabRooms.savedSnapshotCut,
            seedClaimedBy: folioCollabRooms.seedClaimedBy,
            seedState: folioCollabRooms.seedState,
            snapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
            workspaceStatus: workspaces.status,
          })
          .from(folioCollabRooms)
          .innerJoin(
            workspaces,
            eq(workspaces.id, folioCollabRooms.workspaceId),
          ),
    });
    const room = rooms.at(0);
    if (!room || room.workspaceStatus !== "active") {
      return { status: "access-revoked" } as const;
    }
    if (
      room.generation !== value.generation ||
      room.seedState === "empty" ||
      room.seedClaimedBy !== value.userId
    ) {
      return { status: "seed-changed" } as const;
    }
    if (room.savedSnapshotCut !== null) {
      return room.savedSnapshotCut.versionId === room.baseVersionId &&
        room.savedSnapshotCut.sha256Hex === snapshotSha256Hex
        ? ({ status: "acknowledged" } as const)
        : ({ status: "seed-changed" } as const);
    }
    if (room.seedState !== "claimed") {
      return { status: "seed-changed" } as const;
    }
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId: value.organizationId,
      workspaceId: value.workspaceId,
      userId: value.userId,
      execution: {
        performer: { type: "user", id: value.userId },
        trigger: { type: "direct" },
      },
    });
    const savedSnapshotCut = {
      versionId: room.baseVersionId,
      sha256Hex: snapshotSha256Hex,
    };
    const where =
      and(
        eq(folioCollabRooms.id, value.roomId),
        eq(folioCollabRooms.workspaceId, value.workspaceId),
        eq(folioCollabRooms.generation, value.generation),
      ) ?? panic("Seed receipt requires a room predicate");
    const receiptAuditEvent = {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
      resourceId: value.roomId,
      changes: {
        savedSnapshotCut: { old: null, new: savedSnapshotCut },
      },
    };
    if (room.snapshotUpdatedAt === null) {
      await tx.update(folioCollabRooms).set({ savedSnapshotCut }).where(where);
      await recordAuditEvent(tx, receiptAuditEvent);
    } else {
      await transitionScopedCount({
        tx,
        spec: FOLIO_COLLAB_SEED_TRANSITIONS,
        where,
        options: {
          from: ["claimed"],
          to: "seeded",
          set: { savedSnapshotCut, seededAt: new Date() },
        },
        recordTransitionAuditEvent: async (auditTx) => {
          await recordAuditEvent(auditTx, receiptAuditEvent);
        },
      });
    }
    return { status: "acknowledged" } as const;
  });
};
