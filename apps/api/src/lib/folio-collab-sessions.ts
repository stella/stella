import { and, eq } from "drizzle-orm";

import { roles } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { FolioCollabTokenPermissions } from "@/api/db/schema";
import {
  folioCollabSessions,
  folioCollabSessionTokens,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isMemberRole } from "@/api/lib/member-roles";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** Short-lived room tokens limit damage if a browser leaks one. */
export const FOLIO_COLLAB_TOKEN_TTL_MS = 60 * 60 * 1000;
export const FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;

const FOLIO_COLLAB_TOKEN_PART_LENGTH = 32;
export const FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE = "application/octet-stream";
/**
 * Yjs collaborative-edit snapshots are deltas over the base DOCX,
 * not the document itself. 10 MB comfortably covers extended
 * editing sessions (a heavily-edited 100-page document hovers at
 * a few hundred kB of Yjs state) while keeping per-instance peak
 * memory bounded under concurrent traffic.
 */
export const FOLIO_COLLAB_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH =
  Math.ceil(FOLIO_COLLAB_SNAPSHOT_MAX_BYTES / 3) * 4;

export const createFolioCollabToken = () =>
  Bun.randomUUIDv7()
    .replaceAll("-", "")
    .slice(0, FOLIO_COLLAB_TOKEN_PART_LENGTH) +
  Bun.randomUUIDv7()
    .replaceAll("-", "")
    .slice(0, FOLIO_COLLAB_TOKEN_PART_LENGTH);

export const hashFolioCollabToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

export const computeFolioCollabTokenExpiresAt = (
  sessionCreatedAt: Date,
  now = new Date(),
) => {
  const tokenExpiresAtMs = now.getTime() + FOLIO_COLLAB_TOKEN_TTL_MS;
  const sessionExpiresAtMs =
    sessionCreatedAt.getTime() + FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS;

  return new Date(Math.min(tokenExpiresAtMs, sessionExpiresAtMs));
};

export const isFolioCollabSessionExpired = (
  sessionCreatedAt: Date,
  now = new Date(),
) =>
  sessionCreatedAt.getTime() + FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS <=
  now.getTime();

export const computeFolioCollabRefreshTokenExpiresAt = (
  sessionCreatedAt: Date,
  now = new Date(),
) => {
  const tokenExpiresAt = computeFolioCollabTokenExpiresAt(
    sessionCreatedAt,
    now,
  );
  if (tokenExpiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return tokenExpiresAt;
};

export type FolioCollabStoredSessionFile = {
  fileId: SafeId<"userFile">;
  mimeType: typeof DOCX_MIME_TYPE | typeof FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE;
};

export const collectFolioCollabStoredSessionFiles = ({
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
  const storedFiles: FolioCollabStoredSessionFile[] = [];

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

export const deleteFolioCollabStoredSessionFiles = async ({
  files,
  organizationId,
  sessionId,
  workspaceId,
}: {
  files: FolioCollabStoredSessionFile[];
  organizationId: SafeId<"organization">;
  sessionId: SafeId<"folioCollabSession">;
  workspaceId: SafeId<"workspace">;
}) => {
  await Promise.all(
    files.map(async ({ fileId, mimeType }) => {
      const key = createFileKey({
        fileId,
        mimeType,
        organizationId,
        workspaceId,
      });

      await getS3()
        .delete(key)
        .catch((error: unknown) => {
          captureError(error, { sessionId, storageKey: key });
        });
    }),
  );
};

export type AuthorizedFolioCollabSession = {
  canEdit: boolean;
  fileName: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  sessionCreatedAt: Date;
  sessionId: SafeId<"folioCollabSession">;
  tokenExpiresAt: Date;
  tokenId: SafeId<"folioCollabSessionToken">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  yjsSnapshotFileId: SafeId<"userFile">;
};

type IssueFolioCollabTokenOptions = {
  permissions: FolioCollabTokenPermissions;
  sessionCreatedAt: Date;
  sessionId: SafeId<"folioCollabSession">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const issueFolioCollabToken = async ({
  permissions,
  sessionCreatedAt,
  sessionId,
  tx,
  userId,
  workspaceId,
}: IssueFolioCollabTokenOptions) => {
  const token = createFolioCollabToken();
  const tokenExpiresAt = computeFolioCollabTokenExpiresAt(sessionCreatedAt);
  await tx.insert(folioCollabSessionTokens).values({
    expiresAt: tokenExpiresAt,
    id: createSafeId<"folioCollabSessionToken">(),
    permissions,
    sessionId,
    tokenHash: hashFolioCollabToken(token),
    userId,
    workspaceId,
  });

  return { token, tokenExpiresAt };
};

export const refreshFolioCollabToken = async ({
  sessionCreatedAt,
  tokenId,
  tx,
}: {
  sessionCreatedAt: Date;
  tokenId: SafeId<"folioCollabSessionToken">;
  tx: Transaction;
}) => {
  const now = new Date();
  const tokenExpiresAt = computeFolioCollabRefreshTokenExpiresAt(
    sessionCreatedAt,
    now,
  );
  if (!tokenExpiresAt) {
    return null;
  }

  const refreshed = await tx
    .update(folioCollabSessionTokens)
    .set({ expiresAt: tokenExpiresAt })
    .where(eq(folioCollabSessionTokens.id, tokenId))
    .returning({ id: folioCollabSessionTokens.id });

  if (!refreshed.at(0)) {
    return null;
  }

  return { tokenExpiresAt };
};

export type FolioCollabSessionAuthorizationResult =
  | { status: "authorized"; value: AuthorizedFolioCollabSession }
  | { status: "missing" }
  | { status: "token-expired" }
  | { status: "permission-revoked" };

type FolioCollabSessionDecisionInput = {
  expiresAt: Date;
  now: Date;
  sessionCreatedAt: Date;
  organizationRole: string | null;
  sessionStatus: string | null | undefined;
  workspaceMemberId: string | null;
};

/**
 * Pure authorization decision for a folio collaboration session. Splits the
 * status verdict from the side-effecting payload construction so the branch
 * logic can be exercised without a database row.
 */
export const decideFolioCollabSessionStatus = ({
  expiresAt,
  now,
  sessionCreatedAt,
  organizationRole,
  sessionStatus,
  workspaceMemberId,
}: FolioCollabSessionDecisionInput):
  | "authorized"
  | "missing"
  | "token-expired"
  | "permission-revoked" => {
  if (sessionStatus !== "open") {
    return "missing";
  }

  const nowMs = now.getTime();
  if (
    expiresAt.getTime() <= nowMs ||
    isFolioCollabSessionExpired(sessionCreatedAt, now)
  ) {
    return "token-expired";
  }

  const role = organizationRole;
  const canUseWorkspace =
    role !== null &&
    isMemberRole(role) &&
    (role === "owner" || role === "admin" || workspaceMemberId !== null);
  const hasEntityUpdate =
    role !== null &&
    isMemberRole(role) &&
    roles[role].authorize({ entity: ["update"] }).success;

  if (!canUseWorkspace || !hasEntityUpdate) {
    return "permission-revoked";
  }

  return "authorized";
};

export const authorizeFolioCollabSession = async ({
  sessionId,
  token,
}: {
  sessionId: SafeId<"folioCollabSession">;
  token: string;
}): Promise<FolioCollabSessionAuthorizationResult> => {
  const tokenHash = hashFolioCollabToken(token);

  const rows = await rootDb
    .select({
      canEdit: folioCollabSessionTokens.permissions,
      expiresAt: folioCollabSessionTokens.expiresAt,
      fileName: folioCollabSessions.fileName,
      organizationId: workspaces.organizationId,
      organizationRole: member.role,
      sessionCreatedAt: folioCollabSessions.createdAt,
      sessionStatus: folioCollabSessions.status,
      tokenId: folioCollabSessionTokens.id,
      userId: folioCollabSessionTokens.userId,
      workspaceId: folioCollabSessions.workspaceId,
      workspaceMemberId: workspaceMembers.id,
      yjsSnapshotFileId: folioCollabSessions.yjsSnapshotFileId,
    })
    .from(folioCollabSessionTokens)
    .innerJoin(
      folioCollabSessions,
      eq(folioCollabSessionTokens.sessionId, folioCollabSessions.id),
    )
    .innerJoin(workspaces, eq(folioCollabSessions.workspaceId, workspaces.id))
    .leftJoin(
      member,
      and(
        eq(member.userId, folioCollabSessionTokens.userId),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, folioCollabSessionTokens.userId),
        eq(workspaceMembers.workspaceId, folioCollabSessions.workspaceId),
      ),
    )
    .where(
      and(
        eq(folioCollabSessionTokens.sessionId, sessionId),
        eq(folioCollabSessionTokens.tokenHash, tokenHash),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  if (!row) {
    return { status: "missing" };
  }

  const status = decideFolioCollabSessionStatus({
    expiresAt: row.expiresAt,
    now: new Date(),
    sessionCreatedAt: row.sessionCreatedAt,
    organizationRole: row.organizationRole,
    sessionStatus: row.sessionStatus,
    workspaceMemberId: row.workspaceMemberId,
  });
  if (status !== "authorized") {
    return { status };
  }

  return {
    status: "authorized",
    value: {
      canEdit: row.canEdit.canEdit,
      fileName: row.fileName,
      organizationId: row.organizationId,
      scopedDb: createRootScopedDb({
        organizationId: row.organizationId,
        userId: brandPersistedUserId(row.userId),
        workspaceIds: [row.workspaceId],
      }),
      sessionCreatedAt: row.sessionCreatedAt,
      sessionId,
      tokenExpiresAt: row.expiresAt,
      tokenId: row.tokenId,
      userId: brandPersistedUserId(row.userId),
      workspaceId: row.workspaceId,
      yjsSnapshotFileId: row.yjsSnapshotFileId,
    },
  };
};

export const loadFolioCollabSnapshot = async (
  value: AuthorizedFolioCollabSession,
) => {
  const sessions = await rootDb
    .select({
      yjsSnapshotFileId: folioCollabSessions.yjsSnapshotFileId,
      yjsSnapshotUpdatedAt: folioCollabSessions.yjsSnapshotUpdatedAt,
    })
    .from(folioCollabSessions)
    .where(eq(folioCollabSessions.id, value.sessionId))
    .limit(1);

  const session = sessions.at(0);
  if (!session?.yjsSnapshotUpdatedAt) {
    return null;
  }

  const key = createFileKey({
    fileId: session.yjsSnapshotFileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
  });
  const buffer = await getS3().file(key).arrayBuffer();

  return Buffer.from(buffer).toString("base64");
};

export const storeFolioCollabSnapshot = async ({
  snapshotBytes,
  value,
}: {
  snapshotBytes: Uint8Array;
  value: AuthorizedFolioCollabSession;
}) => {
  const key = createFileKey({
    fileId: value.yjsSnapshotFileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
  });
  await getS3().write(key, snapshotBytes);

  const storedAt = new Date();
  await rootDb
    .update(folioCollabSessions)
    .set({
      seededAt: storedAt,
      yjsSnapshotSizeBytes: snapshotBytes.byteLength,
      yjsSnapshotUpdatedAt: storedAt,
    })
    .where(eq(folioCollabSessions.id, value.sessionId));

  return { storedAt, sizeBytes: snapshotBytes.byteLength };
};
