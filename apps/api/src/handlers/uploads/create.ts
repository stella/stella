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
import { t } from "elysia";
import type { Static } from "elysia";

import {
  AGENT_SKILL_SCOPES,
  pendingUploads,
  type PendingUploadPurposeData,
} from "@/api/db/schema";
import { validateAgentSkill } from "@/api/handlers/uploads/agent-skill";
import { validateEntityVersion } from "@/api/handlers/uploads/entity-version";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import {
  captureOutlookIngestion,
  outlookIngestionDiagnosticSchema,
} from "@/api/handlers/uploads/outlook-ingestion-diagnostics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { EML_MIME_TYPE } from "@/api/lib/files/email-to-html";
import { resolveUploadMime } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { presignUploadUrl } from "@/api/lib/s3-presign";
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
> & { parentId: SafeId<"entity"> | null };

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
    "to an existing one, or agent_skill (with scope team or private) for a " +
    "skill pack. Returns uploadId, url, expiresAt, and headers. Step 2: PUT " +
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
  }) {
    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: purposeBody.purpose,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

    if (
      purposeBody.purpose === "entity_create" ||
      purposeBody.purpose === "email_ingest"
    ) {
      // email_ingest shares entity_create's file-property + folder-parent
      // checks. Capacity reserves 1 here; the authoritative count check
      // runs at finalize once the attachment count is known.
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

    const uploadId = createSafeId<"pendingUpload">();
    const tmpKey = tmpUploadKey({
      organizationId: session.activeOrganizationId,
      uploadId,
      workspaceId,
    });
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PRESIGN_URL_EXPIRY_SECONDS * 1000,
    );
    const purposeData = toPurposeData(purposeBody);

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

    type PresignWriteResult =
      | { status: "ok" }
      | { status: EntityCreateWriteFailureStatus };

    // Persist intent. RLS pins the row to this workspace, so even
    // a stolen URL can only be finalized by a request that
    // resolves to the same workspace_ids on the API role.
    const writeResult = yield* Result.await(
      safeDb(async (tx): Promise<PresignWriteResult> => {
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
        await tx.insert(pendingUploads).values({
          id: uploadId,
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
        });

        return { status: "ok" };
      }),
    );
    if (writeResult.status !== "ok") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: entityCreateWriteErrorMessage(writeResult.status),
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
      uploadId,
      url: presign.value.url,
      expiresAt: expiresAt.toISOString(),
      headers: presign.value.headers,
    });
  },
);

export default presignUpload;
