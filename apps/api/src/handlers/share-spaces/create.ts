import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  SHARE_SPACE_DOWNLOAD_POLICIES,
  shareItems,
  shareRecipients,
  shareSpaces,
} from "@/api/db/schema";
import { loadPublicationSource } from "@/api/handlers/share-spaces/publication-source";
import { enqueueSharePublication } from "@/api/handlers/share-spaces/share-publish-queue";
import {
  createShareInvitationSecret,
  hashShareInvitationSecret,
} from "@/api/handlers/share-spaces/token";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { shareSpace: ["create"] },
  mcp: { type: "capability", reason: "external_sharing" },
  access: "write",
  description:
    "Publish one exact document version as an immutable, email-gated Share Space. The operation queues snapshot creation and returns the invitation secret once.",
  params: workspaceParams({}),
  body: t.Object({
    entityId: tSafeId("entity", {
      description: "Document whose exact version will be published.",
    }),
    entityVersionId: tSafeId("entityVersion", {
      description: "Immutable source version to publish.",
    }),
    fieldId: tSafeId("field", {
      description: "File field belonging to the selected document version.",
    }),
    recipientEmail: t.String({
      format: "email",
      maxLength: 320,
      description: "Named recipient address that must pass the later OTP gate.",
    }),
    downloadPolicy: t.UnionEnum(SHARE_SPACE_DOWNLOAD_POLICIES, {
      description: "Whether the recipient may request an attachment download.",
    }),
    expiresAt: t.Nullable(
      t.String({
        format: "date-time",
        description: "Optional ISO timestamp after which access fails closed.",
      }),
    ),
  }),
} satisfies HandlerConfig;

const ERROR_MESSAGE_BY_SOURCE_CODE = {
  invalid_source: "Document version or file field not found.",
  encrypted_source: "Encrypted documents cannot be shared externally.",
  scan_warnings: "Documents with unresolved scan warnings cannot be shared.",
  unsupported_display:
    "This file type cannot be rendered in the external viewer.",
} as const;

const createShareSpace = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    session,
    user,
    body,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Share Space expiration must be in the future.",
        }),
      );
    }

    const sourceResult = yield* Result.await(
      safeDb(
        async (tx) =>
          await loadPublicationSource({
            tx,
            workspaceId,
            entityId: body.entityId,
            entityVersionId: body.entityVersionId,
            fieldId: body.fieldId,
          }),
      ),
    );
    if (sourceResult.status === "error") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: ERROR_MESSAGE_BY_SOURCE_CODE[sourceResult.code],
        }),
      );
    }

    const { source } = sourceResult;
    const shareSpaceId = createSafeId<"shareSpace">();
    const shareRecipientId = createSafeId<"shareRecipient">();
    const shareItemId = createSafeId<"shareItem">();
    const invitationSecret = createShareInvitationSecret();
    const accessTokenHash = hashShareInvitationSecret(invitationSecret);
    const emailNormalized = body.recipientEmail.trim().toLowerCase();

    yield* Result.await(
      safeDb(async (tx) => {
        await tx.insert(shareSpaces).values({
          id: shareSpaceId,
          organizationId,
          workspaceId,
          name: source.displayName.slice(0, 256),
          status: "publishing",
          downloadPolicy: body.downloadPolicy,
          accessTokenHash,
          expiresAt,
          createdBy: user.id,
        });
        await tx.insert(shareRecipients).values({
          id: shareRecipientId,
          organizationId,
          workspaceId,
          shareSpaceId,
          emailNormalized,
          invitedBy: user.id,
        });
        await tx.insert(shareItems).values({
          id: shareItemId,
          organizationId,
          workspaceId,
          shareSpaceId,
          sourceEntityId: source.entityId,
          sourceEntityVersionId: source.entityVersionId,
          sourceFieldId: source.fieldId,
          displayName: source.displayName,
          status: "publishing",
          originalFileName: source.fileName,
          originalMimeType: source.mimeType,
          originalSizeBytes: source.sizeBytes,
          originalSha256Hex: source.sha256Hex,
          versionStamp: source.versionStamp,
          verificationCode: source.verificationCode,
        });

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.SHARE_SPACE,
            resourceId: shareSpaceId,
            metadata: {
              status: "publishing",
              downloadPolicy: body.downloadPolicy,
              expiresAt: expiresAt?.toISOString() ?? null,
            },
          },
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.SHARE_RECIPIENT,
            resourceId: shareRecipientId,
            metadata: { role: "viewer" },
          },
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.SHARE_ITEM,
            resourceId: shareItemId,
            metadata: {
              sourceEntityVersionId: source.entityVersionId,
              status: "publishing",
            },
          },
        ]);
      }),
    );

    const enqueueResult = await Result.tryPromise({
      try: async () =>
        await enqueueSharePublication({
          shareSpaceId,
          shareItemId,
          organizationId,
          workspaceId,
          userId: user.id,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(enqueueResult)) {
      yield* Result.await(
        safeDb(async (tx) => {
          const failedItems = await tx
            .update(shareItems)
            .set({ status: "failed", failureCode: "enqueue_failed" })
            .where(
              and(
                eq(shareItems.id, shareItemId),
                eq(shareItems.status, "publishing"),
              ),
            )
            .returning({ id: shareItems.id });
          const resetSpaces = await tx
            .update(shareSpaces)
            .set({ status: "draft" })
            .where(
              and(
                eq(shareSpaces.id, shareSpaceId),
                eq(shareSpaces.status, "publishing"),
              ),
            )
            .returning({ id: shareSpaces.id });

          if (failedItems.length > 0 || resetSpaces.length > 0) {
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.SHARE_SPACE,
              resourceId: shareSpaceId,
              metadata: { publicationFailure: "enqueue_failed" },
            });
          }
        }),
      );
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to queue Share Space publication.",
          cause: enqueueResult.error,
        }),
      );
    }

    return Result.ok({
      shareSpaceId,
      status: "publishing" as const,
      invitationSecret,
    });
  },
);

export default createShareSpace;
