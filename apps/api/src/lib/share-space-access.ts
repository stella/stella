import { and, eq, gt, isNull, or } from "drizzle-orm";

import { rlsDb, rootDb } from "@/api/db/root";
import { shareItems, shareRecipients, shareSpaces } from "@/api/db/schema";
import { createShareSafeDb } from "@/api/db/scoped";
import { hashShareInvitationSecret } from "@/api/handlers/share-spaces/token";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditAction, AuditResourceType } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

const INVITATION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type RequestServer = {
  requestIP: (request: Request) => { address: string } | null;
};

export type AuthorizedShareRecipient = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  shareSpaceId: SafeId<"shareSpace">;
  shareRecipientId: SafeId<"shareRecipient">;
};

export const isShareInvitationSecret = (value: unknown): value is string =>
  typeof value === "string" && INVITATION_SECRET_PATTERN.test(value);

export const normalizeRecipientEmail = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 320) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

export const findActiveInvitation = async ({
  invitationSecret,
  emailNormalized,
}: {
  invitationSecret: string;
  emailNormalized: string;
}): Promise<AuthorizedShareRecipient | null> => {
  const [row] = await rootDb
    .select({
      organizationId: shareSpaces.organizationId,
      workspaceId: shareSpaces.workspaceId,
      shareSpaceId: shareSpaces.id,
      shareRecipientId: shareRecipients.id,
    })
    .from(shareSpaces)
    .innerJoin(
      shareRecipients,
      eq(shareRecipients.shareSpaceId, shareSpaces.id),
    )
    .where(
      and(
        eq(
          shareSpaces.accessTokenHash,
          hashShareInvitationSecret(invitationSecret),
        ),
        eq(shareSpaces.status, "active"),
        or(
          isNull(shareSpaces.expiresAt),
          gt(shareSpaces.expiresAt, new Date()),
        ),
        eq(shareRecipients.emailNormalized, emailNormalized),
        or(
          eq(shareRecipients.status, "invited"),
          eq(shareRecipients.status, "verified"),
        ),
      ),
    )
    .limit(1);

  return row ?? null;
};

export const authorizeVerifiedShareRecipient = async ({
  shareSpaceId,
  userId,
}: {
  shareSpaceId: SafeId<"shareSpace">;
  userId: SafeId<"user">;
}): Promise<AuthorizedShareRecipient | null> => {
  const [row] = await rootDb
    .select({
      organizationId: shareSpaces.organizationId,
      workspaceId: shareSpaces.workspaceId,
      shareSpaceId: shareSpaces.id,
      shareRecipientId: shareRecipients.id,
    })
    .from(shareSpaces)
    .innerJoin(
      shareRecipients,
      eq(shareRecipients.shareSpaceId, shareSpaces.id),
    )
    .where(
      and(
        eq(shareSpaces.id, shareSpaceId),
        eq(shareSpaces.status, "active"),
        or(
          isNull(shareSpaces.expiresAt),
          gt(shareSpaces.expiresAt, new Date()),
        ),
        eq(shareRecipients.userId, userId),
        eq(shareRecipients.status, "verified"),
      ),
    )
    .limit(1);

  return row ?? null;
};

export const exchangeActiveShareInvitation = async ({
  invitationSecret,
  email,
  userId,
  request,
  server,
}: {
  invitationSecret: string;
  email: string;
  userId: SafeId<"user">;
  request: Request;
  server: RequestServer | null;
}): Promise<{ shareSpaceId: SafeId<"shareSpace"> } | null> =>
  await rootDb.transaction(async (tx) => {
    const emailNormalized = email.trim().toLowerCase();
    const [match] = await tx
      .select({
        organizationId: shareSpaces.organizationId,
        workspaceId: shareSpaces.workspaceId,
        shareSpaceId: shareSpaces.id,
        recipientId: shareRecipients.id,
        recipientStatus: shareRecipients.status,
      })
      .from(shareSpaces)
      .innerJoin(
        shareRecipients,
        eq(shareRecipients.shareSpaceId, shareSpaces.id),
      )
      .where(
        and(
          eq(
            shareSpaces.accessTokenHash,
            hashShareInvitationSecret(invitationSecret),
          ),
          eq(shareSpaces.status, "active"),
          or(
            isNull(shareSpaces.expiresAt),
            gt(shareSpaces.expiresAt, new Date()),
          ),
          eq(shareRecipients.emailNormalized, emailNormalized),
          or(
            eq(shareRecipients.status, "invited"),
            and(
              eq(shareRecipients.status, "verified"),
              eq(shareRecipients.userId, userId),
            ),
          ),
        ),
      )
      .limit(1);
    if (!match) {
      return null;
    }

    if (match.recipientStatus === "invited") {
      const updated = await tx
        .update(shareRecipients)
        .set({ status: "verified", userId, verifiedAt: new Date() })
        .where(
          and(
            eq(shareRecipients.id, match.recipientId),
            eq(shareRecipients.status, "invited"),
          ),
        )
        .returning({ id: shareRecipients.id });
      if (updated.length === 0) {
        return null;
      }
    }

    const recordAuditEvent = createAuditRecorder({
      organizationId: match.organizationId,
      workspaceId: match.workspaceId,
      userId,
      request,
      server,
    });
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.ACCESS,
      resourceType: AUDIT_RESOURCE_TYPE.SHARE_RECIPIENT,
      resourceId: match.recipientId,
      metadata: { event: "recipient_verified" },
    });
    return { shareSpaceId: match.shareSpaceId };
  });

export const loadExternalShareManifest = async ({
  authorization,
  userId,
}: {
  authorization: AuthorizedShareRecipient;
  userId: SafeId<"user">;
}) => {
  const shareSafeDb = createShareSafeDb(
    rlsDb,
    authorization.shareSpaceId,
    userId,
  );
  return await shareSafeDb(async (tx) => {
    const [space] = await tx
      .select({
        id: shareSpaces.id,
        name: shareSpaces.name,
        expiresAt: shareSpaces.expiresAt,
        downloadPolicy: shareSpaces.downloadPolicy,
      })
      .from(shareSpaces)
      .where(eq(shareSpaces.id, authorization.shareSpaceId))
      .limit(1);
    if (!space) {
      return null;
    }
    const items = await tx
      .select({
        id: shareItems.id,
        displayName: shareItems.displayName,
        displayMimeType: shareItems.displayMimeType,
        originalMimeType: shareItems.originalMimeType,
        originalSizeBytes: shareItems.originalSizeBytes,
        versionStamp: shareItems.versionStamp,
        verificationCode: shareItems.verificationCode,
        publishedAt: shareItems.publishedAt,
      })
      .from(shareItems)
      .where(eq(shareItems.shareSpaceId, authorization.shareSpaceId));
    return { ...space, items };
  });
};

export const loadExternalShareItem = async ({
  authorization,
  userId,
  shareItemId,
}: {
  authorization: AuthorizedShareRecipient;
  userId: SafeId<"user">;
  shareItemId: SafeId<"shareItem">;
}) => {
  const shareSafeDb = createShareSafeDb(
    rlsDb,
    authorization.shareSpaceId,
    userId,
  );
  return await shareSafeDb(async (tx) => {
    const [row] = await tx
      .select({
        id: shareItems.id,
        originalFileName: shareItems.originalFileName,
        originalStorageKey: shareItems.originalStorageKey,
        displayStorageKey: shareItems.displayStorageKey,
        downloadPolicy: shareSpaces.downloadPolicy,
      })
      .from(shareItems)
      .innerJoin(shareSpaces, eq(shareSpaces.id, shareItems.shareSpaceId))
      .where(
        and(
          eq(shareItems.id, shareItemId),
          eq(shareItems.shareSpaceId, authorization.shareSpaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
};

export const recordExternalShareAccess = async ({
  authorization,
  userId,
  request,
  server,
  action,
  resourceType,
  resourceId,
  event,
  touchRecipient = false,
}: {
  authorization: AuthorizedShareRecipient;
  userId: SafeId<"user">;
  request: Request;
  server: RequestServer | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  event: string;
  touchRecipient?: boolean;
}): Promise<void> => {
  await rootDb.transaction(async (tx) => {
    if (touchRecipient) {
      await tx
        .update(shareRecipients)
        .set({ lastAccessAt: new Date() })
        .where(eq(shareRecipients.id, authorization.shareRecipientId));
    }
    const recordAuditEvent = createAuditRecorder({
      organizationId: authorization.organizationId,
      workspaceId: authorization.workspaceId,
      userId,
      request,
      server,
    });
    await recordAuditEvent(tx, {
      action,
      resourceType,
      resourceId,
      metadata: { event },
    });
  });
};
