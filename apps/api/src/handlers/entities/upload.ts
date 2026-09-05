import { panic, Result } from "better-result";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatResourceHref,
} from "@stll/api-contract";

import { jsonField } from "@/api/db/json-utils";
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
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { hasPersistedGeneratedDocumentActiveDraftContext } from "@/api/lib/chat/active-draft-context";
import { getGeneratedDocumentDraftState } from "@/api/lib/chat/created-draft";
import { expandThreadDataScopeOnTx } from "@/api/lib/chat/data-scope";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { scanFile } from "@/api/lib/file-scan/scan";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/lib/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/lib/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/lib/files/image-derivative";
import { isEncryptedPdf } from "@/api/lib/files/pdf-utils";
import { createFileKey } from "@/api/lib/files/utils";
import { maybeStartUploadTriggeredFlows } from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { getS3, writeS3ObjectWithRetry } from "@/api/lib/s3";
import type { SanitizedFileName } from "@/api/lib/sanitize-filename";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  processExtraction,
  requestNativeExtractionRun,
} from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";

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

type ResolveFileNameProps = {
  tx: Transaction;
  propertyId: SafeId<"property">;
  name: SanitizedFileName;
};

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

const MAX_FILENAME_LENGTH = 255;

type CleanupUploadedS3KeysOptions = {
  keys: string[];
  fileId: string;
  workspaceId: SafeId<"workspace">;
};

/**
 * Best-effort delete of S3 objects written before an authoritative
 * cap check (or an unexpected error) aborts the upload. Every key's
 * delete is attempted independently (`allSettled`, not `all`) so one
 * rejection doesn't stop cleanup of the rest; any rejection is
 * captured instead of silently dropped, since a swallowed failure
 * here leaves an orphaned S3 object with no telemetry trail.
 */
const cleanupUploadedS3Keys = async ({
  keys,
  fileId,
  workspaceId,
}: CleanupUploadedS3KeysOptions): Promise<void> => {
  const results = await Promise.allSettled(
    keys.map(async (key) => await getS3().delete(key)),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      captureError(result.reason, {
        operation: "upload-s3-cleanup",
        fileId,
        workspaceId,
      });
    }
  }
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

const resolveFileName = async ({
  tx,
  propertyId,
  name,
}: ResolveFileNameProps) => {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot === -1 ? name : name.slice(0, lastDot);
  const ext = lastDot === -1 ? "" : name.slice(lastDot);

  const pattern = `${escapeLike(base)}%${escapeLike(ext)}`;

  const fieldsCount = await tx.$count(
    fields,
    and(
      eq(fields.propertyId, propertyId),
      like(jsonField(fields.content, "v1")("fileName"), pattern),
    ),
  );

  if (fieldsCount === 0) {
    return { renamed: false as const, value: name };
  }

  // Reserve space for the suffix so truncation cannot eat it.
  const suffix = `_${fieldsCount}`;
  const maxBase = MAX_FILENAME_LENGTH - suffix.length - ext.length;
  const truncatedBase = maxBase > 0 ? base.slice(0, maxBase) : base;

  // SAFETY: name is already sanitized; the suffix is digits and underscore only
  return {
    renamed: true as const,
    value: sanitizeFilename(`${truncatedBase}${suffix}${ext}`),
  };
};

const uploadEntityHandler = async function* ({
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
  const scanResult = await scanFile({
    buffer: new Uint8Array(fileBuffer),
    declaredMimeType: file.type,
    fileName: name,
  });

  if (Result.isError(scanResult)) {
    return Result.err(
      new HandlerError({ status: 422, message: "File security scan failed" }),
    );
  }

  if (scanResult.value.verdict === "reject") {
    const reasons: string[] = [];
    for (const f of scanResult.value.findings) {
      if (f.severity === "reject") {
        reasons.push(f.message);
      }
    }
    return Result.err(
      new HandlerError({
        status: 422,
        message: `File rejected: ${reasons.join("; ")}`,
      }),
    );
  }

  let scanWarnings: string[] | undefined;
  if (scanResult.value.verdict === "warn") {
    scanWarnings = [];
    for (const f of scanResult.value.findings) {
      if (f.severity === "warn") {
        scanWarnings.push(f.message);
      }
    }
  }

  let encrypted = false;
  if (file.type === PDF_MIME_TYPE) {
    const result = await isEncryptedPdf(fileBuffer);

    if (Result.isError(result)) {
      captureError(result.error, {
        mimeType: PDF_MIME_TYPE,
        sizeBytes: String(fileBuffer.byteLength),
      });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Failed to open PDF: file appears corrupted",
        }),
      );
    }

    encrypted = result.value;
  }

  const fileId = allocateFileObject();
  const sourceKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: file.type,
  });

  const s3Keys = [sourceKey];

  await writeS3ObjectWithRetry({
    contentType: file.type,
    data: new Uint8Array(fileBuffer),
    key: sourceKey,
  });

  // `yield*` on an Err suspends this generator via `.return()`, not `.throw()`,
  // so a database error here skips `catch` entirely (finally still runs).
  // Track intent to keep the object instead of relying on catch to clean it up.
  let keepUploadedFile = false;
  try {
    const entityId = createSafeId<"entity">();
    const entityVersionId = createSafeId<"entityVersion">();
    const fieldId = createSafeId<"field">();

    const writeResult = yield* Result.await(
      safeDb(async (tx) => {
        // See `lockWorkspacesForEntityCap` for the canonical lock
        // order every entity-creating path follows (issue #1139).
        await lockWorkspacesForEntityCap(tx, [workspaceId]);

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

        const resolvedName = await resolveFileName({ tx, propertyId, name });

        const entityStamp = await allocateEntityStamp(tx, workspaceId);

        await tx.insert(entities).values({
          id: entityId,
          workspaceId,
          name: resolvedName.value,
          createdBy: userId,
          docSequence: entityStamp.docSequence,
        });

        await tx.insert(entityVersions).values({
          id: entityVersionId,
          workspaceId,
          entityId,
          versionNumber: 1,
          stamp: entityStamp.stamp,
          verificationCode: entityStamp.verificationCode,
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
            sizeBytes: file.size,
            encrypted,
            sha256Hex,
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
                sizeBytes: file.size,
                propertyId,
              },
            },
          },
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

    await processExtraction(entityId).catch((error: unknown) =>
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
      await cleanupUploadedS3Keys({ keys: s3Keys, fileId, workspaceId });
    }
  }
};

const config = {
  description:
    "Upload a file as a new document in the current matter over a multipart " +
    "request: the file, a name, and the propertyId of the matter's file " +
    "column. The bytes are scanned before they are stored and a rejected " +
    "file fails the call; text extraction, PDF and thumbnail derivatives, " +
    "and any upload-triggered flows start afterwards. An agent surface " +
    "cannot send multipart: use uploads.create with purpose entity_create " +
    "and then uploads.update.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "document_processing" },
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
} satisfies HandlerConfig;

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
  permissions: { entity: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  body: uploadGeneratedDocumentBodySchema,
} satisfies HandlerConfig;

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
