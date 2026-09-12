/**
 * Generic presigned-upload entrypoint. The body's `purpose` field
 * picks the per-surface validation + future finalize callback;
 * everything else (limits, MIME, expiry, signed-URL generation) is
 * shared.
 *
 * Phase 1 wires only `entity_create`. Phases 2–4 will extend the
 * `t.Union(...)` and add a `switch(body.purpose)` branch.
 */
import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { OutlookPresignResponse } from "@stll/api-contract";

import {
  AGENT_SKILL_SCOPES,
  pendingUploads,
  type PendingUploadPurposeData,
} from "@/api/db/schema";
import { validateAgentSkill } from "@/api/handlers/uploads/agent-skill";
import { validateEntityVersion } from "@/api/handlers/uploads/entity-version";
import {
  captureOutlookIngestion,
  outlookIngestionDiagnosticSchema,
} from "@/api/handlers/uploads/outlook-ingestion-diagnostics";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { EML_MIME_TYPE } from "@/api/lib/files/email-to-html";
import { resolveUploadMime } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { presignUploadUrl } from "@/api/lib/s3-presign";
import { deriveOutlookEmailSourceKey } from "@/api/lib/uploads/email-ingest-source";
import {
  checkEntityCreateCapacityForInsert,
  checkEntityCreateTargetForInsert,
  entityCreateWriteErrorMessage,
  type EntityCreateWriteFailureStatus,
  validateEntityCreate,
} from "@/api/lib/uploads/entity-create";
import {
  PRESIGN_URL_EXPIRY_SECONDS,
  sha256HexToBase64,
  tmpUploadKey,
  UPLOAD_REJECT_REASON,
} from "@/api/lib/uploads/runtime";

const baseFileMetadataSchema = {
  name: tDefaultVarchar,
  mimeType: t.String({ minLength: 1, maxLength: 255 }),
  size: t.Integer({
    // A zero-byte document is never a legitimate upload; require at least
    // one byte so an empty object can't be presigned and finalized.
    minimum: 1,
    // S3 enforces this via the signed Content-Length; finalize
    // re-checks via S3.HEAD. Pinning it at the schema level lets
    // the API refuse oversized requests before even minting a URL.
    maximum: FILE_SIZE_LIMIT_BYTES.document,
  }),
  // Lowercase hex, exactly 64 chars. The same format the legacy
  // entity upload stores at `fields.content.sha256Hex`, so we can
  // round-trip without re-encoding inside the migration.
  sha256Hex: t.RegExp(/^[0-9a-f]{64}$/u),
} as const;

const skillPackFileMetadataSchema = {
  ...baseFileMetadataSchema,
  size: t.Integer({
    minimum: 1,
    maximum: FILE_SIZE_LIMIT_BYTES.skillPack,
  }),
} as const;

const RETRYABLE_EMAIL_RESERVATION_REJECT_REASONS: ReadonlySet<string> = new Set(
  [UPLOAD_REJECT_REASON.CLIENT_ABORT, UPLOAD_REJECT_REASON.URL_EXPIRED],
);

const entityCreatePresignBodySchema = t.Object({
  purpose: t.Literal("entity_create"),
  propertyId: tSafeId("property"),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
  ...baseFileMetadataSchema,
});

const entityVersionPresignBodySchema = t.Object({
  purpose: t.Literal("entity_version"),
  entityId: tSafeId("entity"),
  ...baseFileMetadataSchema,
});

const emailIngestPresignBodySchema = t.Object({
  purpose: t.Literal("email_ingest"),
  propertyId: tSafeId("property"),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
  diagnostic: t.Optional(outlookIngestionDiagnosticSchema),
  source: t.Object({
    mailboxEmail: t.String({ format: "email", maxLength: 320 }),
    sourceId: t.String({ format: "uuid" }),
  }),
  ...baseFileMetadataSchema,
  mimeType: t.Literal(EML_MIME_TYPE),
});

const agentSkillPresignBodySchema = t.Object({
  purpose: t.Literal("agent_skill"),
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  // Skill packs use the smaller `skillPack` budget enforced by the
  // legacy upload, capped here too.
  ...skillPackFileMetadataSchema,
});

const presignBodySchema = t.Union([
  entityCreatePresignBodySchema,
  entityVersionPresignBodySchema,
  agentSkillPresignBodySchema,
  emailIngestPresignBodySchema,
]);

type PresignBody = Static<typeof presignBodySchema>;

type EntityCreatePurposeDataWithParent = Extract<
  PendingUploadPurposeData,
  { type: "entity_create" }
> & { parentId: SafeId<"entity"> | null };

type EmailIngestPurposeDataWithParent = Extract<
  PendingUploadPurposeData,
  { type: "email_ingest" }
> & { parentId: SafeId<"entity"> | null; sourceKey: string };

type PresignPurposeData =
  | EntityCreatePurposeDataWithParent
  | EmailIngestPurposeDataWithParent
  | Exclude<
      PendingUploadPurposeData,
      { type: "entity_create" } | { type: "email_ingest" }
    >;

const toPurposeData = (purposeBody: PresignBody): PresignPurposeData => {
  if (purposeBody.purpose === "entity_create") {
    const purposeData: EntityCreatePurposeDataWithParent = {
      type: "entity_create",
      propertyId: purposeBody.propertyId,
      parentId: purposeBody.parentId ?? null,
    };
    return purposeData;
  }
  if (purposeBody.purpose === "email_ingest") {
    const purposeData: EmailIngestPurposeDataWithParent = {
      type: "email_ingest",
      propertyId: purposeBody.propertyId,
      parentId: purposeBody.parentId ?? null,
      sourceKey: deriveOutlookEmailSourceKey({
        source: purposeBody.source,
      }),
    };
    return purposeData;
  }
  if (purposeBody.purpose === "entity_version") {
    return {
      type: "entity_version",
      entityId: purposeBody.entityId,
    };
  }
  return { type: "agent_skill", scope: purposeBody.scope };
};

const config = {
  description:
    "Step 1 of 3 of the file-upload flow: reserve an upload and mint a " +
    "short-lived presigned S3 PUT URL. This is the ONLY way to get a file " +
    "into stella from an agent surface; the multipart endpoints cannot be " +
    "called with JSON. Pass purpose plus the file metadata: name, mimeType, " +
    "size in bytes, and sha256Hex (lowercase hex SHA-256 of the exact " +
    "bytes). purpose is entity_create (with propertyId, optional parentId) " +
    "to add a new document, entity_version (with entityId) to add a version " +
    "to an existing one, agent_skill (with scope team or private) for a " +
    "skill pack, or email_ingest with a stable Outlook source identity. " +
    "Returns a reserved upload with uploadId, url, expiresAt, and headers; " +
    "a previously reserved email source returns its existing uploadId. Step 2: PUT " +
    "the bytes to url with those headers verbatim -- the URL is signed " +
    "against the exact size and checksum, so any deviation is rejected. " +
    "Step 3: call uploads.update with the uploadId to commit the record. " +
    "Call uploads.delete instead if the PUT fails.",
  // permissions-exempt: the static gate is workspace:read because the
  // resource-appropriate grant depends on the request's purpose, which
  // authorizeUploadPurpose (uploads/permissions.ts) checks in-handler.
  permissions: uploadRoutePermission,
  access: "write",
  mcp: { type: "capability", reason: "file_transport" },
  body: presignBodySchema,
} satisfies HandlerConfig;

const presignUpload = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    memberRole,
    body: purposeBody,
  }): SafeHandlerGenerator<OutlookPresignResponse> {
    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: purposeBody.purpose,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

    if (purposeBody.purpose === "entity_create") {
      const validation = yield* validateEntityCreate({
        safeDb,
        workspaceId,
        propertyId: purposeBody.propertyId,
        parentId: purposeBody.parentId ?? null,
      });
      if (validation.status === "error") {
        return validation;
      }
    }

    if (purposeBody.purpose === "entity_version") {
      const validation = yield* validateEntityVersion({
        safeDb,
        workspaceId,
        entityId: purposeBody.entityId,
      });
      if (validation.status === "error") {
        return validation;
      }
    }

    if (purposeBody.purpose === "agent_skill") {
      const validation = validateAgentSkill({
        memberRole,
        scope: purposeBody.scope,
      });
      if (validation.status === "error") {
        return validation;
      }
    }

    // Recover a usable MIME type for extensions browsers mistype
    // (e.g. .msg → octet-stream). The frontend PUTs with the exact
    // headers we sign below, so the resolved type is what reaches S3
    // and the pending-upload row — no client-side normalization.
    const resolvedMime = resolveUploadMime({
      declaredMime: purposeBody.mimeType,
      fileName: purposeBody.name,
    });

    const candidateUploadId = createSafeId<"pendingUpload">();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PRESIGN_URL_EXPIRY_SECONDS * 1000,
    );
    const purposeData = toPurposeData(purposeBody);

    type PresignWriteResult =
      | {
          disposition: "existing" | "reserved";
          expiresAt: Date;
          status: "ok";
          uploadId: SafeId<"pendingUpload">;
        }
      | { status: EntityCreateWriteFailureStatus | "source-conflict" };

    // Persist intent. RLS pins the row to this workspace, so even
    // a stolen URL can only be finalized by a request that
    // resolves to the same workspace_ids on the API role.
    const writeResult = yield* Result.await(
      safeDb(async (tx): Promise<PresignWriteResult> => {
        if (purposeData.type === "email_ingest") {
          const existing = (
            await tx
              .select()
              .from(pendingUploads)
              .where(
                and(
                  eq(
                    pendingUploads.organizationId,
                    session.activeOrganizationId,
                  ),
                  eq(pendingUploads.workspaceId, workspaceId),
                  eq(pendingUploads.purpose, "email_ingest"),
                  sql`${pendingUploads.purposeData}->>'sourceKey' = ${purposeData.sourceKey}`,
                ),
              )
              .limit(1)
              .for("update")
          ).at(0);
          if (existing) {
            if (
              existing.userId !== user.id ||
              existing.purposeData.type !== "email_ingest"
            ) {
              return { status: "source-conflict" };
            }
            if (
              existing.status === "rejected" &&
              existing.rejectReason !== null &&
              RETRYABLE_EMAIL_RESERVATION_REJECT_REASONS.has(
                existing.rejectReason,
              )
            ) {
              const capacityResult = await checkEntityCreateCapacityForInsert({
                tx,
                workspaceId,
                entityCount: 1,
              });
              if (Result.isError(capacityResult)) {
                return { status: capacityResult.error };
              }
              const targetResult = await checkEntityCreateTargetForInsert({
                tx,
                workspaceId,
                propertyId: purposeData.propertyId,
                parentId: purposeData.parentId,
              });
              if (Result.isError(targetResult)) {
                return { status: targetResult.error };
              }
              await tx
                .update(pendingUploads)
                .set({
                  claimedAt: null,
                  claimedByRequestId: null,
                  declaredMime: resolvedMime,
                  declaredName: purposeBody.name,
                  declaredSha256: purposeBody.sha256Hex,
                  declaredSize: purposeBody.size,
                  expiresAt,
                  finalizedAt: null,
                  finalizedResult: null,
                  purposeData,
                  rejectReason: null,
                  status: "pending",
                })
                .where(
                  and(
                    eq(pendingUploads.id, existing.id),
                    eq(pendingUploads.status, "rejected"),
                  ),
                );
              return {
                disposition: "reserved",
                expiresAt,
                status: "ok",
                uploadId: existing.id,
              };
            }
            if (existing.status !== "pending") {
              return {
                disposition: "existing",
                expiresAt: existing.expiresAt,
                status: "ok",
                uploadId: existing.id,
              };
            }
            const isExpired = existing.expiresAt <= now;
            if (
              existing.purposeData.propertyId !== purposeData.propertyId ||
              (existing.purposeData.parentId ?? null) !==
                purposeData.parentId ||
              (!isExpired &&
                (existing.declaredName !== purposeBody.name ||
                  existing.declaredMime !== resolvedMime ||
                  existing.declaredSize !== purposeBody.size ||
                  existing.declaredSha256 !== purposeBody.sha256Hex))
            ) {
              return { status: "source-conflict" };
            }
            const reservationExpiresAt = isExpired
              ? expiresAt
              : existing.expiresAt;
            if (isExpired) {
              const capacityResult = await checkEntityCreateCapacityForInsert({
                tx,
                workspaceId,
                entityCount: 1,
              });
              if (Result.isError(capacityResult)) {
                return { status: capacityResult.error };
              }
              const targetResult = await checkEntityCreateTargetForInsert({
                tx,
                workspaceId,
                propertyId: purposeData.propertyId,
                parentId: purposeData.parentId,
              });
              if (Result.isError(targetResult)) {
                return { status: targetResult.error };
              }
              await tx
                .update(pendingUploads)
                .set({
                  declaredMime: resolvedMime,
                  declaredName: purposeBody.name,
                  declaredSha256: purposeBody.sha256Hex,
                  declaredSize: purposeBody.size,
                  expiresAt: reservationExpiresAt,
                })
                .where(
                  and(
                    eq(pendingUploads.id, existing.id),
                    eq(pendingUploads.status, "pending"),
                  ),
                );
            }
            return {
              disposition: "reserved",
              expiresAt: reservationExpiresAt,
              status: "ok",
              uploadId: existing.id,
            };
          }
        }

        if (
          purposeData.type === "entity_create" ||
          purposeData.type === "email_ingest"
        ) {
          // Reserve capacity for 1 entity. email_ingest fans out into
          // additional attachment entities, but their count is unknown
          // until the email is parsed at finalize; the authoritative
          // capacity check there reserves `1 + attachments`.
          const capacityResult = await checkEntityCreateCapacityForInsert({
            tx,
            workspaceId,
            entityCount: 1,
          });
          if (Result.isError(capacityResult)) {
            return { status: capacityResult.error };
          }

          const targetResult = await checkEntityCreateTargetForInsert({
            tx,
            workspaceId,
            propertyId: purposeData.propertyId,
            parentId: purposeData.parentId ?? null,
          });
          if (Result.isError(targetResult)) {
            return { status: targetResult.error };
          }
        }

        // audit: skip — presigned URL bookkeeping; the audit row is
        // emitted by the per-purpose finalize once the upload
        // becomes a durable entity.
        const inserted = await tx
          .insert(pendingUploads)
          .values({
            id: candidateUploadId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            userId: user.id,
            purpose: purposeBody.purpose,
            purposeData,
            declaredName: purposeBody.name,
            declaredMime: resolvedMime,
            declaredSize: purposeBody.size,
            declaredSha256: purposeBody.sha256Hex,
            status: "pending",
            expiresAt,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: pendingUploads.id });
        if (!inserted.at(0)) {
          if (purposeData.type === "email_ingest") {
            const concurrent = (
              await tx
                .select()
                .from(pendingUploads)
                .where(
                  and(
                    eq(
                      pendingUploads.organizationId,
                      session.activeOrganizationId,
                    ),
                    eq(pendingUploads.workspaceId, workspaceId),
                    eq(pendingUploads.purpose, "email_ingest"),
                    sql`${pendingUploads.purposeData}->>'sourceKey' = ${purposeData.sourceKey}`,
                  ),
                )
                .limit(1)
            ).at(0);
            if (
              concurrent?.userId === user.id &&
              concurrent.purposeData.type === "email_ingest"
            ) {
              if (concurrent.status !== "pending") {
                return {
                  disposition: "existing",
                  expiresAt: concurrent.expiresAt,
                  status: "ok",
                  uploadId: concurrent.id,
                };
              }
              if (
                concurrent.declaredName === purposeBody.name &&
                concurrent.declaredMime === resolvedMime &&
                concurrent.declaredSize === purposeBody.size &&
                concurrent.declaredSha256 === purposeBody.sha256Hex &&
                concurrent.purposeData.propertyId === purposeData.propertyId &&
                (concurrent.purposeData.parentId ?? null) ===
                  purposeData.parentId
              ) {
                return {
                  disposition: "reserved",
                  expiresAt: concurrent.expiresAt,
                  status: "ok",
                  uploadId: concurrent.id,
                };
              }
            }
          }
          return { status: "source-conflict" };
        }

        return {
          disposition: "reserved",
          expiresAt,
          status: "ok",
          uploadId: candidateUploadId,
        };
      }),
    );
    if (writeResult.status !== "ok") {
      return Result.err(
        new HandlerError({
          status: writeResult.status === "source-conflict" ? 409 : 400,
          message:
            writeResult.status === "source-conflict"
              ? "This Outlook email already has an incompatible filing reservation"
              : entityCreateWriteErrorMessage(writeResult.status),
        }),
      );
    }

    if (writeResult.disposition === "existing") {
      return Result.ok({
        state: "existing" as const,
        uploadId: writeResult.uploadId,
      });
    }

    const tmpKey = tmpUploadKey({
      organizationId: session.activeOrganizationId,
      uploadId: writeResult.uploadId,
      workspaceId,
    });
    const presign = await presignUploadUrl({
      key: tmpKey,
      expiresIn: PRESIGN_URL_EXPIRY_SECONDS,
      contentType: resolvedMime,
      contentLength: purposeBody.size,
      sha256Base64: sha256HexToBase64(purposeBody.sha256Hex),
      scope: {
        organizationId: session.activeOrganizationId,
        workspaceId,
      },
      tagAsTemporaryUpload: true,
    });
    if (Result.isError(presign)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to issue upload URL",
          cause: presign.error,
        }),
      );
    }

    if (purposeBody.purpose === "email_ingest") {
      captureOutlookIngestion({
        diagnostic: purposeBody.diagnostic,
        durableState: "pending",
        operation: "reserve",
        organizationId: session.activeOrganizationId,
        outcome: "in_progress",
        retryStage: "upload",
        userId: user.id,
        workspaceId,
      });
    }

    return Result.ok({
      state: "reserved" as const,
      uploadId: writeResult.uploadId,
      url: presign.value.url,
      expiresAt: writeResult.expiresAt.toISOString(),
      headers: presign.value.headers,
    });
  },
);

export default presignUpload;
