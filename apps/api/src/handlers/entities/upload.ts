import { panic, Result } from "better-result";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatResourceHref,
} from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  entities,
  entityVersions,
  fileChatThreads,
  fields,
  workspaces,
} from "@/api/db/schema";
import {
  UPLOAD_ENTITY_ORIGIN,
  uploadTriggeredFlowPolicy,
} from "@/api/handlers/entities/upload-origin";
import { entityFileRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  cleanupObjectAfterWriter,
  lockObjectCleanupIntentsForWriter,
  reserveObjectCleanupIntent,
  retirePublishedObjectCleanupIntentsInTransaction,
} from "@/api/lib/buffer-intent-reconciliation";
import { hasPersistedGeneratedDocumentActiveDraftContext } from "@/api/lib/chat/active-draft-context";
import { getGeneratedDocumentDraftState } from "@/api/lib/chat/created-draft";
import { expandThreadDataScopeOnTx } from "@/api/lib/chat/data-scope";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { insertNamedEntity } from "@/api/lib/entities/sibling-name-insert";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { insertEntityVersion } from "@/api/lib/entity-versions/insert-entity-version";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import { deleteOrganizationFilesWithSignal } from "@/api/lib/files/delete-organization-file";
import {
  detectFileEncryption,
  uploadFileEncryption,
} from "@/api/lib/files/detect-file-encryption";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/lib/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/lib/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/lib/files/image-derivative";
import {
  organizationFileUsageHandlerError,
  OrganizationFileUsageError,
  writeOrganizationFile,
} from "@/api/lib/files/organization-file-usage";
import { storedDocumentBytes } from "@/api/lib/files/stored-document-bytes";
import { createFileKey } from "@/api/lib/files/utils";
import {
  maybeStartUploadTriggeredFlows,
  recordUploadTriggeredFlowIntents,
} from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import type { SanitizedFileName } from "@/api/lib/sanitize-filename";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  processExtraction,
  requestNativeExtractionRun,
} from "@/api/lib/search/process-extraction";
import { resolveEntityCreateFileName } from "@/api/lib/uploads/entity-create";

const cleanupSettlementFailure = failureSink({
  event: "entities.upload_cleanup_settlement_failed",
  expected: [],
});

const uploadEntityBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
  name: tDefaultVarchar,
  propertyId: tSafeId("property"),
});

const uploadGeneratedDocumentBodySchema = t.Object({
  ...uploadEntityBodySchema.properties,
  contentSha256Hex: t.RegExp(/^[0-9a-f]{64}$/u),
  draftChatThreadId: t.Optional(tSafeId("chatThread")),
  messageId: tSafeId("chatMessage"),
  threadId: tSafeId("chatThread"),
  threadWorkspaceId: t.Optional(tSafeId("workspace")),
  toolCallId: t.String(),
});

type UploadEntityHandlerProps = {
  fileUsageDb?: Parameters<typeof writeOrganizationFile>[0]["db"];
  processEntity?: typeof processExtraction;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof uploadEntityBodySchema> & {
    origin: (typeof UPLOAD_ENTITY_ORIGIN)[keyof typeof UPLOAD_ENTITY_ORIGIN];
  };
  generatedDraft?:
    | {
        messageId: SafeId<"chatMessage">;
        contentSha256Hex: string;
        draftChatThreadId?: SafeId<"chatThread"> | undefined;
        threadId: SafeId<"chatThread">;
        threadWorkspaceId?: SafeId<"workspace"> | undefined;
        toolCallId: string;
      }
    | undefined;
};

type GeneratedDocumentDraftIdentity = NonNullable<
  UploadEntityHandlerProps["generatedDraft"]
>;

type DraftChatThread = {
  dataWorkspaceIds: SafeId<"workspace">[];
  workspaceId: SafeId<"workspace"> | null;
};

type GeneratedDocumentDraftChatThreadLookup =
  | { status: "not-bound" }
  | { status: "not-supplied" }
  | {
      chatThreadId: SafeId<"chatThread">;
      draftThread: DraftChatThread;
      status: "bound";
    };

type ExistingFileChatThreadLink = {
  chatThreadId: SafeId<"chatThread">;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  userId: string;
  workspaceId: SafeId<"workspace">;
};

type GeneratedDocumentDraftThreadLink = {
  chatThreadId: SafeId<"chatThread">;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  userId: string;
  workspaceId: SafeId<"workspace">;
};

export const resolveGeneratedDocumentDraftThreadScope = ({
  destinationWorkspaceId,
  threadWorkspaceId,
}: {
  destinationWorkspaceId: SafeId<"workspace">;
  threadWorkspaceId: SafeId<"workspace"> | null;
}): "already-scoped" | "promote" =>
  threadWorkspaceId === destinationWorkspaceId ? "already-scoped" : "promote";

export const hasExactGeneratedDocumentDraftThreadLink = ({
  existingLinks,
  expected,
}: {
  existingLinks: ExistingFileChatThreadLink[];
  expected: GeneratedDocumentDraftThreadLink;
}): boolean => {
  if (existingLinks.length !== 1) {
    return false;
  }

  const existingLink = existingLinks.at(0);
  if (existingLink === undefined) {
    return false;
  }

  return (
    existingLink.chatThreadId === expected.chatThreadId &&
    existingLink.entityId === expected.entityId &&
    existingLink.fieldId === expected.fieldId &&
    existingLink.organizationId === expected.organizationId &&
    existingLink.userId === expected.userId &&
    existingLink.workspaceId === expected.workspaceId
  );
};

export const resolveGeneratedDocumentDraftThreadLinkPreflight = ({
  hasExistingLink,
}: {
  hasExistingLink: boolean;
}): "conflict" | "continue" => (hasExistingLink ? "conflict" : "continue");

type UploadWriteFailureReason =
  | "content-mismatch"
  | "draft-thread-not-bound"
  | "draft-thread-conflict"
  | "entity-limit"
  | "invalid-property"
  | "missing-draft";

type GeneratedDocumentUploadResult = {
  entityId: string;
  fieldId: string;
  fileId: string;
  fileName: string;
  renamed: boolean;
};

type GeneratedDocumentDraftPreflight =
  | { status: "content-mismatch" }
  | { status: "draft-thread-not-bound" }
  | { status: "invalid" }
  | { status: "ready" }
  | { result: GeneratedDocumentUploadResult; status: "saved" };

const uploadWriteFailureMessage = (
  reason: UploadWriteFailureReason,
): string => {
  switch (reason) {
    case "content-mismatch":
      return "Generated document content does not match the requested draft";
    case "draft-thread-not-bound":
      return "Generated document draft is not bound to this chat";
    case "draft-thread-conflict":
      return "Generated document draft chat is already linked elsewhere";
    case "entity-limit":
      return "Entities limit reached";
    case "invalid-property":
      return "Property not found or not a file property";
    case "missing-draft":
      return "Generated document draft not found";
    default:
      reason satisfies never;
      return panic(`Unhandled reason: ${String(reason)}`);
  }
};

const uploadWriteFailureStatus = (
  reason: UploadWriteFailureReason,
): 400 | 409 => {
  switch (reason) {
    case "content-mismatch":
    case "draft-thread-not-bound":
    case "draft-thread-conflict":
    case "missing-draft":
      return 409;
    case "entity-limit":
    case "invalid-property":
      return 400;
    default:
      reason satisfies never;
      return panic(`Unhandled reason: ${String(reason)}`);
  }
};

type CleanupUploadedS3KeysOptions = {
  fileUsageDb?: Parameters<typeof writeOrganizationFile>[0]["db"];
  keys: string[];
  fileId: string;
  workspaceId: SafeId<"workspace">;
};

/**
 * Best-effort delete of S3 objects written before an authoritative
 * cap check (or an unexpected error) aborts the upload. Every key's
 * delete is attempted independently (`allSettled`, not `all`) so one
 * rejection doesn't stop cleanup of the rest; any failure is
 * captured instead of silently dropped, since a swallowed failure
 * here leaves an orphaned S3 object with no telemetry trail.
 */
const cleanupUploadedS3Keys = async ({
  keys,
  fileId,
  workspaceId,
  fileUsageDb,
}: CleanupUploadedS3KeysOptions): Promise<boolean> => {
  const cleanup = Result.flatten(
    await Result.tryPromise({
      try: async () =>
        await deleteOrganizationFilesWithSignal(
          keys,
          AbortSignal.timeout(10_000),
          fileUsageDb === undefined ? {} : { fileUsageDb },
        ),
      catch: (cause) => cause,
    }),
  );
  if (Result.isError(cleanup)) {
    captureError(cleanup.error, {
      operation: "upload-s3-cleanup",
      fileId,
      workspaceId,
    });
  }
  return Result.isOk(cleanup);
};

type ResolveSavedGeneratedDocumentProps = {
  tx: Transaction;
  output: {
    entityId: string;
    fieldId: string;
    fileName: string;
    workspaceId: string;
  };
  requestedFileName: SanitizedFileName;
  requestedSha256Hex: string;
  workspaceId: SafeId<"workspace">;
};

const resolveSavedGeneratedDocument = async ({
  tx,
  output,
  requestedFileName,
  requestedSha256Hex,
  workspaceId,
}: ResolveSavedGeneratedDocumentProps): Promise<
  GeneratedDocumentUploadResult | "content-mismatch" | null
> => {
  if (output.workspaceId !== workspaceId) {
    return null;
  }

  const [savedField] = await tx
    .select({
      content: fields.content,
      entityId: entities.id,
      fieldId: fields.id,
    })
    .from(entities)
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, entities.currentVersionId),
        eq(entityVersions.entityId, entities.id),
        eq(entityVersions.workspaceId, entities.workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      fields,
      and(
        sql`${fields.id} = ${output.fieldId}::uuid`,
        eq(fields.entityVersionId, entityVersions.id),
        eq(fields.workspaceId, entities.workspaceId),
      ),
    )
    .where(
      and(
        sql`${entities.id} = ${output.entityId}::uuid`,
        eq(entities.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (savedField?.content.type !== "file") {
    return null;
  }

  if (savedField.content.sha256Hex !== requestedSha256Hex) {
    return "content-mismatch" as const;
  }

  return {
    entityId: savedField.entityId,
    fieldId: savedField.fieldId,
    fileId: savedField.content.id,
    fileName: savedField.content.fileName,
    renamed: savedField.content.fileName !== requestedFileName,
  };
};

type PreflightGeneratedDocumentDraftProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  fileName: SanitizedFileName;
  generatedDraft: GeneratedDocumentDraftIdentity;
};

type FindGeneratedDocumentDraftStateProps = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  fileName: SanitizedFileName;
  generatedDraft: GeneratedDocumentDraftIdentity;
  lock: "none" | "for-update";
};

const findGeneratedDocumentDraftState = async ({
  tx,
  organizationId,
  userId,
  fileName,
  generatedDraft,
  lock,
}: FindGeneratedDocumentDraftStateProps) => {
  const query = tx
    .select({
      content: chatMessages.content,
      dataWorkspaceIds: chatThreads.dataWorkspaceIds,
      threadWorkspaceId: chatThreads.workspaceId,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(
      and(
        eq(chatMessages.id, generatedDraft.messageId),
        eq(chatMessages.threadId, generatedDraft.threadId),
        eq(chatMessages.userId, userId),
        eq(chatMessages.role, "assistant"),
        eq(chatThreads.userId, userId),
        eq(chatThreads.organizationId, organizationId),
        generatedDraft.threadWorkspaceId === undefined
          ? isNull(chatThreads.workspaceId)
          : eq(chatThreads.workspaceId, generatedDraft.threadWorkspaceId),
      ),
    )
    .limit(1);

  const toDraftState = (
    message:
      | {
          content: unknown;
          dataWorkspaceIds: SafeId<"workspace">[];
          threadWorkspaceId: SafeId<"workspace"> | null;
        }
      | undefined,
  ) => {
    if (message === undefined) {
      return { status: "invalid" } as const;
    }

    const draftState = getGeneratedDocumentDraftState({
      persistedContent: message.content,
      fileName,
      toolCallId: generatedDraft.toolCallId,
    });
    return draftState.status === "ready"
      ? {
          ...draftState,
          dataWorkspaceIds: message.dataWorkspaceIds,
          threadWorkspaceId: message.threadWorkspaceId,
        }
      : draftState;
  };

  switch (lock) {
    case "none":
      return toDraftState((await query).at(0));
    case "for-update":
      return toDraftState((await query.for("update")).at(0));
    default:
      lock satisfies never;
      return panic(`Unhandled lock: ${String(lock)}`);
  }
};

const findGeneratedDocumentDraftChatThread = async ({
  generatedDraft,
  organizationId,
  tx,
  userId,
}: {
  generatedDraft: GeneratedDocumentDraftIdentity;
  organizationId: SafeId<"organization">;
  tx: Transaction;
  userId: SafeId<"user">;
}): Promise<GeneratedDocumentDraftChatThreadLookup> => {
  if (generatedDraft.draftChatThreadId === undefined) {
    return { status: "not-supplied" };
  }

  const hasBoundDraftContext =
    await hasPersistedGeneratedDocumentActiveDraftContext({
      generatedDraft: {
        originChatMessageId: generatedDraft.messageId,
        originChatThreadId: generatedDraft.threadId,
        toolCallId: generatedDraft.toolCallId,
      },
      organizationId,
      threadId: generatedDraft.draftChatThreadId,
      tx,
      userId,
    });
  if (!hasBoundDraftContext) {
    return { status: "not-bound" };
  }

  const draftThread = await tx
    .select({
      dataWorkspaceIds: chatThreads.dataWorkspaceIds,
      workspaceId: chatThreads.workspaceId,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, generatedDraft.draftChatThreadId),
        eq(chatThreads.organizationId, organizationId),
        eq(chatThreads.userId, userId),
      ),
    )
    .limit(1)
    .for("update");
  const foundDraftThread = draftThread.at(0);
  return foundDraftThread === undefined
    ? { status: "not-bound" }
    : {
        chatThreadId: generatedDraft.draftChatThreadId,
        draftThread: foundDraftThread,
        status: "bound",
      };
};

const findExistingGeneratedDocumentDraftChatThreadLink = async ({
  chatThreadId,
  tx,
}: {
  chatThreadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<boolean> => {
  const existing = await tx
    .select({ id: fileChatThreads.id })
    .from(fileChatThreads)
    .where(eq(fileChatThreads.chatThreadId, chatThreadId))
    .limit(1)
    .for("update");
  return existing.length > 0;
};

const linkGeneratedDocumentDraftChatThread = async ({
  draftThread,
  entityId,
  fieldId,
  generatedDraft,
  organizationId,
  recordAuditEvent,
  tx,
  userId,
  workspaceId,
}: {
  draftThread: DraftChatThread | null;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  generatedDraft: GeneratedDocumentDraftIdentity;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  if (draftThread === null || generatedDraft.draftChatThreadId === undefined) {
    return;
  }

  const scopeAction = resolveGeneratedDocumentDraftThreadScope({
    destinationWorkspaceId: workspaceId,
    threadWorkspaceId: draftThread.workspaceId,
  });
  if (scopeAction === "promote") {
    const promotedThread = await tx
      .update(chatThreads)
      .set({ workspaceId })
      .where(
        and(
          eq(chatThreads.id, generatedDraft.draftChatThreadId),
          draftThread.workspaceId === null
            ? isNull(chatThreads.workspaceId)
            : eq(chatThreads.workspaceId, draftThread.workspaceId),
        ),
      )
      .returning({ id: chatThreads.id });
    if (promotedThread.length !== 1) {
      panic("Generated draft chat thread promotion lost its locked scope");
    }
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
      resourceId: generatedDraft.draftChatThreadId,
      workspaceId,
      changes: {
        workspaceId: {
          old: draftThread.workspaceId,
          new: workspaceId,
        },
      },
    });
  }

  // A locally empty draft chat has no durable thread to preserve. Once the
  // user has sent a message, the authenticated dedicated draft chat becomes
  // the destination file chat: first promote its authoritative scope, then
  // widen the data scope before associating destination-file metadata.
  await expandThreadDataScopeOnTx({
    newWorkspaceIds: [workspaceId],
    recordAuditEvent,
    threadId: generatedDraft.draftChatThreadId,
    threadWorkspaceId: workspaceId,
    tx,
  });
  const fileChatThreadId = createSafeId<"fileChatThread">();
  const inserted = await tx
    .insert(fileChatThreads)
    .values({
      id: fileChatThreadId,
      organizationId,
      workspaceId,
      userId,
      entityId,
      fieldId,
      chatThreadId: generatedDraft.draftChatThreadId,
    })
    .onConflictDoNothing()
    .returning({ id: fileChatThreads.id });
  if (inserted.length === 0) {
    const existingLinks = await tx
      .select({
        chatThreadId: fileChatThreads.chatThreadId,
        entityId: fileChatThreads.entityId,
        fieldId: fileChatThreads.fieldId,
        organizationId: fileChatThreads.organizationId,
        userId: fileChatThreads.userId,
        workspaceId: fileChatThreads.workspaceId,
      })
      .from(fileChatThreads)
      .where(
        or(
          eq(fileChatThreads.chatThreadId, generatedDraft.draftChatThreadId),
          and(
            eq(fileChatThreads.organizationId, organizationId),
            eq(fileChatThreads.workspaceId, workspaceId),
            eq(fileChatThreads.userId, userId),
            eq(fileChatThreads.entityId, entityId),
            eq(fileChatThreads.fieldId, fieldId),
          ),
        ),
      )
      .for("update");
    if (
      hasExactGeneratedDocumentDraftThreadLink({
        existingLinks,
        expected: {
          chatThreadId: generatedDraft.draftChatThreadId,
          entityId,
          fieldId,
          organizationId,
          userId,
          workspaceId,
        },
      })
    ) {
      panic("Draft chat link existed despite locked-link preflight");
    }
    panic("Draft chat link conflicts despite locked-link preflight");
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: generatedDraft.draftChatThreadId,
    workspaceId,
    metadata: { entityId, fieldId, fileChatThreadId },
  });
};

const preflightGeneratedDocumentDraft = async ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  fileName,
  generatedDraft,
}: PreflightGeneratedDocumentDraftProps) =>
  await safeDb(async (tx): Promise<GeneratedDocumentDraftPreflight> => {
    const draftState = await findGeneratedDocumentDraftState({
      tx,
      organizationId,
      userId,
      fileName,
      generatedDraft,
      lock: "none",
    });
    switch (draftState.status) {
      case "invalid":
        return { status: "invalid" };
      case "ready": {
        if (generatedDraft.draftChatThreadId === undefined) {
          return { status: "ready" };
        }
        const draftChatThread = await findGeneratedDocumentDraftChatThread({
          generatedDraft,
          organizationId,
          tx,
          userId,
        });
        return draftChatThread.status === "not-bound"
          ? { status: "draft-thread-not-bound" }
          : { status: "ready" };
      }
      case "saved": {
        const saved = await resolveSavedGeneratedDocument({
          tx,
          output: draftState.output,
          requestedFileName: fileName,
          requestedSha256Hex: generatedDraft.contentSha256Hex,
          workspaceId,
        });
        if (saved === "content-mismatch") {
          return { status: "content-mismatch" };
        }
        return saved === null
          ? { status: "invalid" }
          : { result: saved, status: "saved" };
      }
      default:
        draftState satisfies never;
        return panic(`Unhandled draft state: ${String(draftState)}`);
    }
  });

export const uploadEntityHandler = async function* ({
  fileUsageDb,
  processEntity = processExtraction,
  safeDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  generatedDraft,
  body: { file, name: rawName, origin, propertyId },
}: UploadEntityHandlerProps) {
  const name = sanitizeFilename(rawName);

  if (generatedDraft !== undefined) {
    const preflightResult = yield* await preflightGeneratedDocumentDraft({
      safeDb,
      organizationId,
      workspaceId,
      userId,
      fileName: name,
      generatedDraft,
    });
    switch (preflightResult.status) {
      case "content-mismatch":
        return Result.err(
          new HandlerError({
            status: 409,
            message: uploadWriteFailureMessage("content-mismatch"),
          }),
        );
      case "draft-thread-not-bound":
        return Result.err(
          new HandlerError({
            status: 409,
            message: uploadWriteFailureMessage("draft-thread-not-bound"),
          }),
        );
      case "invalid":
        return Result.err(
          new HandlerError({
            status: 409,
            message: uploadWriteFailureMessage("missing-draft"),
          }),
        );
      case "saved":
        return Result.ok(preflightResult.result);
      case "ready":
        break;
      default:
        preflightResult satisfies never;
        return panic(`Unhandled preflight result: ${String(preflightResult)}`);
    }
  }

  // Non-authoritative fast-fail: cheap, unlocked, avoids scanning
  // and uploading a file for a request that's obviously over the
  // limit. The authoritative check is inside the write transaction
  // below, behind the workspace-row lock.
  const [entityCountResult, propertyResult] = await Promise.all([
    safeDb((tx) => tx.$count(entities, eq(entities.workspaceId, workspaceId))),
    safeDb((tx) =>
      tx.query.properties.findFirst({
        columns: { id: true, content: true },
        where: { id: { eq: propertyId }, workspaceId: { eq: workspaceId } },
      }),
    ),
  ]);

  const entityCount = yield* entityCountResult;
  const property = yield* propertyResult;

  if (entityCount >= LIMITS.entitiesCount) {
    return Result.err(
      new HandlerError({ status: 400, message: "Entities limit reached" }),
    );
  }

  if (!property) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Property not found in workspace",
      }),
    );
  }

  if (property.content.type !== "file") {
    return Result.err(
      new HandlerError({ status: 400, message: "Property isn't of type file" }),
    );
  }

  const fileBuffer = await file.arrayBuffer();
  const sha256Hex = new Bun.CryptoHasher("sha256")
    .update(fileBuffer)
    .digest("hex");

  if (
    generatedDraft !== undefined &&
    sha256Hex !== generatedDraft.contentSha256Hex
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: uploadWriteFailureMessage("content-mismatch"),
      }),
    );
  }

  // Security scan before S3 upload
  const scanResult = await scanUploadForHandler({
    bytes: fileBuffer,
    declaredMimeType: file.type,
    fileName: name,
  });
  if (Result.isError(scanResult)) {
    return Result.err(scanResult.error);
  }
  const scanned = scanResult.value;
  const scanWarnings = scanned.scanWarnings ?? undefined;

  // Scanning and the draft-content check above judge what the client sent, so
  // they run on the submitted bytes. Everything from here describes the stored
  // ones, which never carry a document reference.
  const { bytes: storedBytes, strippedArchive } =
    await storedDocumentBytes(fileBuffer);
  const storedSizeBytes = storedBytes.byteLength;
  const storedSha256Hex =
    strippedArchive === null
      ? sha256Hex
      : new Bun.CryptoHasher("sha256").update(storedBytes).digest("hex");

  const encryption = uploadFileEncryption(
    await detectFileEncryption({ mimeType: file.type, scanned }),
    { mimeType: file.type, sizeBytes: String(fileBuffer.byteLength) },
  );
  if (encryption === null) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Failed to open PDF: file appears corrupted",
      }),
    );
  }
  const { encrypted } = encryption;

  const fileId = allocateFileObject();
  const sourceKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: file.type,
  });

  const s3Keys = [sourceKey];
  const cleanupIntentId = yield* Result.await(
    reserveObjectCleanupIntent({
      objectKey: sourceKey,
      organizationId,
      safeDb,
      workspaceId,
    }),
  );
  // Exhausted attempts can still finish late; only a confirmed write narrows this.
  let writeState: S3ObjectWriteCertainty | "never-written" = "never-written";
  let keepUploadedFile = false;
  try {
    if (isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
      const organizationFileWrite = await writeOrganizationFile({
        organizationId,
        objectKey: sourceKey,
        sizeBytes: storedSizeBytes,
        ...(fileUsageDb === undefined ? {} : { db: fileUsageDb }),
        write: async () => {
          writeState = S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN;
          return await writeS3ObjectWithRetry(
            {
              contentType: file.type,
              data: storedBytes,
              key: sourceKey,
            },
            { type: "cleanup-intent", intent: cleanupIntentId },
          );
        },
      });
      if (Result.isError(organizationFileWrite)) {
        return Result.err(
          organizationFileUsageHandlerError(organizationFileWrite.error),
        );
      }
      writeState = organizationFileWrite.value;
    } else {
      writeState = S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN;
      writeState = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await writeS3ObjectWithRetry(
              {
                contentType: file.type,
                data: storedBytes,
                key: sourceKey,
              },
              { type: "cleanup-intent", intent: cleanupIntentId },
            ),
          catch: (cause) =>
            new OrganizationFileUsageError({
              reason: "storage_unavailable",
              message: "Organization file usage is unavailable",
              cause,
            }),
        }),
      );
    }
    const entityId = createSafeId<"entity">();
    const entityVersionId = createSafeId<"entityVersion">();
    const fieldId = createSafeId<"field">();

    const writeResult = yield* Result.await(
      safeDb(async (tx) => {
        // See `lockWorkspacesForEntityCap` for the canonical lock
        // order every entity-creating path follows (issue #1139).
        await lockWorkspacesForEntityCap(tx, [workspaceId]);
        await lockObjectCleanupIntentsForWriter(tx, [cleanupIntentId]);

        let generatedDraftLocator: {
          partIndex: number;
          persistenceVersion: 2 | 3;
        } | null = null;
        let generatedDraftThreadWorkspaceId: SafeId<"workspace"> | null = null;
        let draftChatThread: DraftChatThread | null = null;
        if (generatedDraft !== undefined) {
          const draftState = await findGeneratedDocumentDraftState({
            tx,
            organizationId,
            userId,
            fileName: name,
            generatedDraft,
            lock: "for-update",
          });
          if (draftState.status === "invalid") {
            return { ok: false as const, reason: "missing-draft" as const };
          }
          if (draftState.status === "saved") {
            const saved = await resolveSavedGeneratedDocument({
              tx,
              output: draftState.output,
              requestedFileName: name,
              requestedSha256Hex: generatedDraft.contentSha256Hex,
              workspaceId,
            });
            if (saved === "content-mismatch") {
              return {
                ok: false as const,
                reason: "content-mismatch" as const,
              };
            }
            if (saved === null) {
              return { ok: false as const, reason: "missing-draft" as const };
            }
            return {
              ok: true as const,
              result: saved,
              status: "replayed" as const,
            };
          }
          generatedDraftLocator = draftState.locator;
          generatedDraftThreadWorkspaceId = draftState.threadWorkspaceId;
          const draftChatThreadLookup =
            await findGeneratedDocumentDraftChatThread({
              generatedDraft,
              organizationId,
              tx,
              userId,
            });
          if (draftChatThreadLookup.status === "not-bound") {
            return {
              ok: false as const,
              reason: "draft-thread-not-bound" as const,
            };
          }
          if (draftChatThreadLookup.status === "bound") {
            draftChatThread = draftChatThreadLookup.draftThread;
            const hasExistingLink =
              await findExistingGeneratedDocumentDraftChatThreadLink({
                chatThreadId: draftChatThreadLookup.chatThreadId,
                tx,
              });
            if (
              resolveGeneratedDocumentDraftThreadLinkPreflight({
                hasExistingLink,
              }) === "conflict"
            ) {
              return {
                ok: false as const,
                reason: "draft-thread-conflict" as const,
              };
            }
          }
        }

        // The earlier `entityCount` check above is a
        // non-authoritative fast-fail to avoid wasted scan/upload
        // work; this is the authoritative check.
        const authoritativeEntityCount = await tx.$count(
          entities,
          eq(entities.workspaceId, workspaceId),
        );
        if (authoritativeEntityCount >= LIMITS.entitiesCount) {
          return { ok: false as const, reason: "entity-limit" as const };
        }

        const resolvedName = await resolveEntityCreateFileName({
          tx,
          workspaceId,
          parentId: null,
          name,
        });

        const entityStamp = await allocateEntityStamp(tx, workspaceId);

        await insertNamedEntity(tx, {
          id: entityId,
          workspaceId,
          name: resolvedName.name,
          createdBy: userId,
          docSequence: entityStamp.docSequence,
        });

        await insertEntityVersion(tx, {
          id: entityVersionId,
          workspaceId,
          entityId,
          versionNumber: 1,
          stamp: entityStamp.stamp,
        });

        await tx
          .update(entities)
          .set({ currentVersionId: entityVersionId })
          .where(eq(entities.id, entityId));

        await tx.insert(fields).values({
          id: fieldId,
          workspaceId,
          propertyId: property.id,
          entityVersionId,
          content: fileContentWithMintedObject({
            type: "file",
            version: 1,
            id: fileId,
            fileName: resolvedName.value,
            mimeType: file.type,
            sizeBytes: storedSizeBytes,
            encryption,
            sha256Hex: storedSha256Hex,
            pdfFileId: null,
            pdfDerivative: pdfDerivativeStateForFile({
              encrypted,
              mimeType: file.type,
            }),
            thumbnailFileId: null,
            thumbnailDerivative: thumbnailDerivativeStateForFile({
              encrypted,
              mimeType: file.type,
            }),
            ...(scanWarnings !== undefined && { scanWarnings }),
          }),
        });

        if (generatedDraft !== undefined && generatedDraftLocator !== null) {
          const href = toChatResourceHref({
            type: RESOURCE_TYPE.ENTITY,
            resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
            location: {
              type: "workspace",
              workspace: resourceRef({
                type: RESOURCE_TYPE.WORKSPACE,
                id: workspaceId,
              }),
            },
          });
          const generatedOutput = {
            success: true,
            entityId,
            entityRef: entityId,
            fieldId,
            fileName: resolvedName.value,
            href,
            matterRef: workspaceId,
            mention: `[${resolvedName.value}](${href})`,
            workspaceId,
          } as const;
          const outputPath =
            generatedDraftLocator.persistenceVersion === 3
              ? `{data,${generatedDraftLocator.partIndex},output,value}`
              : `{data,${generatedDraftLocator.partIndex},output}`;
          // The destination reference becomes durable in this source chat
          // message. Widen the source thread first, in this transaction, so a
          // global thread can never retain destination-matter data without
          // the RLS scope that protects it.
          await expandThreadDataScopeOnTx({
            newWorkspaceIds: [workspaceId],
            recordAuditEvent,
            threadId: generatedDraft.threadId,
            threadWorkspaceId: generatedDraftThreadWorkspaceId,
            tx,
          });
          await tx
            .update(chatMessages)
            .set({
              content: sql`jsonb_set(
                ${chatMessages.content},
                ${outputPath}::text[],
                ${JSON.stringify(generatedOutput)}::text::jsonb,
                false
              )`,
            })
            .where(eq(chatMessages.id, generatedDraft.messageId));
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
            resourceId: generatedDraft.messageId,
            workspaceId: generatedDraft.threadWorkspaceId ?? null,
            changes: {
              createDocumentDestination: {
                old: "draft",
                new: "matter",
              },
            },
          });
          await linkGeneratedDocumentDraftChatThread({
            draftThread: draftChatThread,
            entityId,
            fieldId,
            generatedDraft,
            organizationId,
            recordAuditEvent,
            tx,
            userId,
            workspaceId,
          });
        }

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

        await requestNativeExtractionRun({ entityId, tx });
        if (uploadTriggeredFlowPolicy(origin) === "start") {
          await recordUploadTriggeredFlowIntents(tx, {
            entityId,
            workspaceId,
            organizationId,
            fileName: resolvedName.value,
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entityId,
          changes: {
            created: {
              old: null,
              new: {
                kind: "document",
                fileName: resolvedName.value,
                mimeType: file.type,
                sizeBytes: storedSizeBytes,
                propertyId,
              },
            },
          },
        });

        await retirePublishedObjectCleanupIntentsInTransaction({
          intentIds: [cleanupIntentId],
          tx,
        });
        return { ok: true as const, resolvedName, status: "created" as const };
      }),
    );

    if (!writeResult.ok) {
      return Result.err(
        new HandlerError({
          status: uploadWriteFailureStatus(writeResult.reason),
          message: uploadWriteFailureMessage(writeResult.reason),
        }),
      );
    }

    if (writeResult.status === "replayed") {
      return Result.ok(writeResult.result);
    }

    // Past this point the entity now owns the uploaded object; finally must
    // not delete it.
    keepUploadedFile = true;
    const fileName = writeResult.resolvedName;

    await processEntity(entityId).catch((error: unknown) =>
      captureError(error, { entityId, mimeType: file.type }),
    );

    if (uploadTriggeredFlowPolicy(origin) === "start") {
      maybeStartUploadTriggeredFlows({
        entityId,
        workspaceId,
        organizationId,
        fileName: fileName.value,
      }).catch((error: unknown) => {
        captureError(error, { entityId, workspaceId });
      });
    }

    enqueuePdfDerivativeOrMarkFailed({
      encrypted,
      entityId,
      fieldId,
      mimeType: file.type,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, {
        entityId,
        fieldId,
        mimeType: file.type,
      });
    });

    enqueueImageThumbnailOrMarkFailed({
      encrypted,
      entityId,
      fieldId,
      mimeType: file.type,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, {
        entityId,
        fieldId,
        mimeType: file.type,
      });
    });

    return Result.ok({
      entityId,
      fieldId,
      fileId,
      fileName: fileName.value,
      renamed: fileName.renamed,
    });
  } finally {
    if (!keepUploadedFile) {
      const settled = await cleanupObjectAfterWriter({
        safeDb,
        intentId: cleanupIntentId,
        writeState,
        deleteObject: async () =>
          await cleanupUploadedS3Keys({
            keys: s3Keys,
            fileId,
            workspaceId,
            fileUsageDb,
          }),
      });
      if (Result.isError(settled)) {
        observeFailure(settled.error, {
          sink: cleanupSettlementFailure,
          ctx: { workspaceId },
        });
      }
    }
  }
};

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Stores document content and returns operation metadata rather than stored-file bytes.",
  },
  description:
    "Upload a file as a new document in the current matter over a multipart " +
    "request: the file, a name, and the propertyId of the matter's file " +
    "column. The bytes are scanned before they are stored and a rejected " +
    "file fails the call; text extraction, PDF and thumbnail derivatives, " +
    "and any upload-triggered flows start afterwards. An agent surface " +
    "cannot send multipart: use uploads.create with purpose entity_create " +
    "and then uploads.update.",
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityFileRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [] },
    alternative: {
      type: "complete",
      via: ["uploads.create", "uploads.update"],
      note: "presign with purpose entity_create, PUT the bytes to the returned URL, then finalize",
    },
  },
  body: uploadEntityBodySchema,
} satisfies WorkspaceHandlerConfig;

const uploadEntity = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
  }) {
    return yield* uploadEntityHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body: { ...body, origin: UPLOAD_ENTITY_ORIGIN.USER },
    });
  },
);

const generatedDocumentConfig = {
  contentDelivery: {
    type: "none",
    reason:
      "Stores document content and returns operation metadata rather than stored-file bytes.",
  },
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityFileRealtimeUpdates,
  mcp: { type: "internal", reason: "assistant_chat" },
  body: uploadGeneratedDocumentBodySchema,
} satisfies WorkspaceHandlerConfig;

export const uploadGeneratedDocument = createSafeHandler(
  generatedDocumentConfig,
  async function* ({
    body,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    return yield* uploadEntityHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      generatedDraft: {
        contentSha256Hex: body.contentSha256Hex,
        draftChatThreadId: body.draftChatThreadId,
        messageId: body.messageId,
        threadId: body.threadId,
        threadWorkspaceId: body.threadWorkspaceId,
        toolCallId: body.toolCallId,
      },
      body: {
        file: body.file,
        name: body.name,
        origin: UPLOAD_ENTITY_ORIGIN.GENERATED_DOCUMENT,
        propertyId: body.propertyId,
      },
    });
  },
);

export default uploadEntity;
