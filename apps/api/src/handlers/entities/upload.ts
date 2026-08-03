import { Result } from "better-result";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { jsonField } from "@/api/db/json-utils";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  entities,
  entityVersions,
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
import { getGeneratedDocumentDraftState } from "@/api/lib/chat/created-draft";
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
import { getS3 } from "@/api/lib/s3";
import type { SanitizedFileName } from "@/api/lib/sanitize-filename";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
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
        threadId: SafeId<"chatThread">;
        threadWorkspaceId?: SafeId<"workspace"> | undefined;
        toolCallId: string;
      }
    | undefined;
};

type ResolveFileNameProps = {
  tx: Transaction;
  propertyId: SafeId<"property">;
  name: SanitizedFileName;
};

type UploadWriteFailureReason =
  | "entity-limit"
  | "invalid-property"
  | "missing-draft";

const uploadWriteFailureMessage = (
  reason: UploadWriteFailureReason,
): string => {
  switch (reason) {
    case "entity-limit":
      return "Entities limit reached";
    case "invalid-property":
      return "Property not found or not a file property";
    case "missing-draft":
      return "Generated document draft not found";
    default:
      return reason satisfies never;
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

  if (generatedDraft === undefined && entityCount >= LIMITS.entitiesCount) {
    return Result.err(
      new HandlerError({ status: 400, message: "Entities limit reached" }),
    );
  }

  if (!property && generatedDraft === undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Property not found in workspace",
      }),
    );
  }

  if (
    property !== undefined &&
    property.content.type !== "file" &&
    generatedDraft === undefined
  ) {
    return Result.err(
      new HandlerError({ status: 400, message: "Property isn't of type file" }),
    );
  }

  const fileBuffer = await file.arrayBuffer();
  const sha256Hex = new Bun.CryptoHasher("sha256")
    .update(fileBuffer)
    .digest("hex");

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

  await getS3().write(sourceKey, new Uint8Array(fileBuffer));

  try {
    const entityId = createSafeId<"entity">();
    const entityVersionId = createSafeId<"entityVersion">();
    const fieldId = createSafeId<"field">();

    const writeResult = yield* Result.await(
      safeDb(async (tx) => {
        // See `lockWorkspacesForEntityCap` for the canonical lock
        // order every entity-creating path follows (issue #1139).
        await lockWorkspacesForEntityCap(tx, [workspaceId]);

        let generatedDraftPartIndex: number | null = null;
        if (generatedDraft !== undefined) {
          const [message] = await tx
            .select({
              content: chatMessages.content,
              id: chatMessages.id,
              role: chatMessages.role,
            })
            .from(chatMessages)
            .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
            .where(
              and(
                eq(chatMessages.id, generatedDraft.messageId),
                eq(chatMessages.threadId, generatedDraft.threadId),
                eq(chatMessages.userId, userId),
                eq(chatThreads.userId, userId),
                eq(chatThreads.organizationId, organizationId),
                generatedDraft.threadWorkspaceId === undefined
                  ? isNull(chatThreads.workspaceId)
                  : eq(
                      chatThreads.workspaceId,
                      generatedDraft.threadWorkspaceId,
                    ),
              ),
            )
            .limit(1)
            .for("update");
          if (!message || message.role !== "assistant") {
            return { ok: false as const, reason: "missing-draft" as const };
          }
          const draftState = getGeneratedDocumentDraftState({
            persistedContent: message.content,
            fileName: name,
            toolCallId: generatedDraft.toolCallId,
          });
          if (draftState.status === "invalid") {
            return { ok: false as const, reason: "missing-draft" as const };
          }
          if (draftState.status === "saved") {
            if (draftState.output.workspaceId !== workspaceId) {
              return { ok: false as const, reason: "missing-draft" as const };
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
                  sql`${fields.id} = ${draftState.output.fieldId}::uuid`,
                  eq(fields.entityVersionId, entityVersions.id),
                  eq(fields.workspaceId, entities.workspaceId),
                ),
              )
              .where(
                and(
                  sql`${entities.id} = ${draftState.output.entityId}::uuid`,
                  eq(entities.workspaceId, workspaceId),
                ),
              )
              .limit(1);
            if (savedField?.content.type !== "file") {
              return { ok: false as const, reason: "missing-draft" as const };
            }
            return {
              ok: true as const,
              result: {
                entityId: savedField.entityId,
                fieldId: savedField.fieldId,
                fileId: savedField.content.id,
                fileName: savedField.content.fileName,
                renamed: savedField.content.fileName !== name,
              },
              status: "replayed" as const,
            };
          }
          generatedDraftPartIndex = draftState.partIndex;
        }

        if (!property || property.content.type !== "file") {
          return { ok: false as const, reason: "invalid-property" as const };
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

        if (generatedDraft !== undefined && generatedDraftPartIndex !== null) {
          const href = `#stella-entity=${workspaceId}:${entityId}`;
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
          const outputPath = `{data,${generatedDraftPartIndex},output}`;
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
        }

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

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
      await cleanupUploadedS3Keys({ keys: s3Keys, fileId, workspaceId });
      return Result.err(
        new HandlerError({
          status: writeResult.reason === "missing-draft" ? 409 : 400,
          message: uploadWriteFailureMessage(writeResult.reason),
        }),
      );
    }

    if (writeResult.status === "replayed") {
      await cleanupUploadedS3Keys({ keys: s3Keys, fileId, workspaceId });
      return Result.ok(writeResult.result);
    }

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
  } catch (error) {
    await cleanupUploadedS3Keys({ keys: s3Keys, fileId, workspaceId });
    throw error;
  }
};

const config = {
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "document_processing" },
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
