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
import { resolveUploadMime } from "@/api/handlers/files/utils";
import { validateAgentSkill } from "@/api/handlers/uploads/agent-skill";
import { validateEntityCreate } from "@/api/handlers/uploads/entity-create";
import { validateEntityVersion } from "@/api/handlers/uploads/entity-version";
import {
  PRESIGN_URL_EXPIRY_SECONDS,
  sha256HexToBase64,
  tmpUploadKey,
} from "@/api/handlers/uploads/lib";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { presignUploadUrl } from "@/api/lib/s3-presign";

const baseFileMetadataSchema = {
  name: tDefaultVarchar,
  mimeType: t.String({ minLength: 1, maxLength: 255 }),
  size: t.Integer({
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
  ...baseFileMetadataSchema,
});

const entityVersionPresignBodySchema = t.Object({
  purpose: t.Literal("entity_version"),
  entityId: tSafeId("entity"),
  ...baseFileMetadataSchema,
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
]);

type PresignBody = Static<typeof presignBodySchema>;

const toPurposeData = (purposeBody: PresignBody): PendingUploadPurposeData => {
  if (purposeBody.purpose === "entity_create") {
    return {
      type: "entity_create",
      propertyId: purposeBody.propertyId,
    };
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
  permissions: uploadRoutePermission,
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

    if (purposeBody.purpose === "entity_create") {
      const validation = yield* validateEntityCreate({
        safeDb,
        workspaceId,
        propertyId: purposeBody.propertyId,
      });
      if (Result.isError(validation)) {
        return validation;
      }
    } else if (purposeBody.purpose === "entity_version") {
      const validation = yield* validateEntityVersion({
        safeDb,
        workspaceId,
        entityId: purposeBody.entityId,
      });
      if (validation.status === "error") {
        return validation;
      }
    } else {
      const validation = yield* validateAgentSkill({
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
        }),
      );
    }

    // Persist intent. RLS pins the row to this workspace, so even
    // a stolen URL can only be finalized by a request that
    // resolves to the same workspace_ids on the API role.
    yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — presigned URL bookkeeping; the audit row is
        // emitted by the per-purpose finalize once the upload
        // becomes a durable entity.
        return tx.insert(pendingUploads).values({
          id: uploadId,
          organizationId: session.activeOrganizationId,
          workspaceId,
          userId: user.id,
          purpose: purposeBody.purpose,
          purposeData: toPurposeData(purposeBody),
          declaredName: purposeBody.name,
          declaredMime: resolvedMime,
          declaredSize: purposeBody.size,
          declaredSha256: purposeBody.sha256Hex,
          status: "pending",
          expiresAt,
          createdAt: now,
        });
      }),
    );

    return Result.ok({
      uploadId,
      url: presign.value.url,
      expiresAt: expiresAt.toISOString(),
      headers: presign.value.headers,
    });
  },
);

export default presignUpload;
