import { and, eq } from "drizzle-orm";

import { roles } from "@stll/permissions";

import type { ScopedDb, Transaction } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { FolioCollabTokenPermissions } from "@/api/db/schema";
import {
  folioCollabSessions,
  folioCollabSessionTokens,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isMemberRole } from "@/api/lib/member-roles";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/** Short-lived room tokens limit damage if a browser leaks one. */
export const FOLIO_COLLAB_TOKEN_TTL_MS = 60 * 60 * 1000;

const FOLIO_COLLAB_TOKEN_PART_LENGTH = 32;
export const FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE = "application/octet-stream";
export const FOLIO_COLLAB_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
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

export const computeFolioCollabTokenExpiresAt = () =>
  new Date(Date.now() + FOLIO_COLLAB_TOKEN_TTL_MS);

export type AuthorizedFolioCollabSession = {
  canEdit: boolean;
  fileName: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  sessionId: SafeId<"folioCollabSession">;
  tokenExpiresAt: Date;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  yjsSnapshotFileId: SafeId<"userFile">;
};

type IssueFolioCollabTokenOptions = {
  permissions: FolioCollabTokenPermissions;
  sessionId: SafeId<"folioCollabSession">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const issueFolioCollabToken = async ({
  permissions,
  sessionId,
  tx,
  userId,
  workspaceId,
}: IssueFolioCollabTokenOptions) => {
  const token = createFolioCollabToken();
  const tokenExpiresAt = computeFolioCollabTokenExpiresAt();
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

export type FolioCollabSessionAuthorizationResult =
  | { status: "authorized"; value: AuthorizedFolioCollabSession }
  | { status: "missing" }
  | { status: "token-expired" }
  | { status: "permission-revoked" };

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
      sessionStatus: folioCollabSessions.status,
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
  if (!row || row.sessionStatus !== "open") {
    return { status: "missing" };
  }

  if (row.expiresAt < new Date()) {
    return { status: "token-expired" };
  }

  const role = row.organizationRole;
  const canUseWorkspace =
    role !== null &&
    isMemberRole(role) &&
    (role === "owner" || role === "admin" || row.workspaceMemberId !== null);
  const hasEntityUpdate =
    role !== null &&
    isMemberRole(role) &&
    roles[role].authorize({ entity: ["update"] }).success;

  if (!canUseWorkspace || !hasEntityUpdate) {
    return { status: "permission-revoked" };
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
      sessionId,
      tokenExpiresAt: row.expiresAt,
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
  snapshotBase64,
  value,
}: {
  snapshotBase64: string;
  value: AuthorizedFolioCollabSession;
}) => {
  const buffer = Buffer.from(snapshotBase64, "base64");
  const key = createFileKey({
    fileId: value.yjsSnapshotFileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
  });
  await getS3().write(key, buffer);

  const storedAt = new Date();
  await rootDb
    .update(folioCollabSessions)
    .set({
      seededAt: storedAt,
      yjsSnapshotSizeBytes: buffer.byteLength,
      yjsSnapshotUpdatedAt: storedAt,
    })
    .where(eq(folioCollabSessions.id, value.sessionId));

  return { storedAt, sizeBytes: buffer.byteLength };
};
