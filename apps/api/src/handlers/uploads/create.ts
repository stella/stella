import { Result } from "better-result";
/**
 * Generic presigned-upload entrypoint. The body's `purpose` field
 * picks the per-surface validation + future finalize callback;
 * everything else (limits, MIME, expiry, signed-URL generation) is
 * shared.
 *
 * Phase 1 wires only `entity_create`. Phases 2–4 will extend the
 * `v.union(...)` and add a `switch(body.purpose)` branch.
 */
import * as v from "valibot";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { validateAgentSkill } from "@/api/handlers/uploads/agent-skill";
import { validateEntityVersion } from "@/api/handlers/uploads/entity-version";
import {
  authorizeUploadConsent,
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { clientPreviewDeclarationSchema } from "@/api/lib/uploads/client-preview";
import { validateEntityCreate } from "@/api/lib/uploads/entity-create";
import {
  documentUploadFileFields,
  uploadFileSizeSchema,
} from "@/api/lib/uploads/file-metadata-schema";
import {
  importDocumentSource,
  importOriginSchema,
} from "@/api/lib/uploads/import-origin";
import {
  type PresignPurposeData,
  reservePresignedUpload,
} from "@/api/lib/uploads/reserve-presigned-upload";

const skillPackFileMetadataSchema = {
  ...documentUploadFileFields,
  size: uploadFileSizeSchema(FILE_SIZE_LIMIT_BYTES.skillPack),
} as const;

const entityCreatePresignBodySchema = v.object({
  purpose: v.literal("entity_create"),
  propertyId: resourceIdSchema("property"),
  parentId: v.optional(v.nullable(resourceIdSchema("entity"))),
  importOrigin: v.optional(importOriginSchema),
  preview: v.optional(clientPreviewDeclarationSchema),
  ...documentUploadFileFields,
});

const entityVersionPresignBodySchema = v.object({
  purpose: v.literal("entity_version"),
  entityId: resourceIdSchema("entity"),
  preview: v.optional(clientPreviewDeclarationSchema),
  ...documentUploadFileFields,
});

const agentSkillPresignBodySchema = v.object({
  purpose: v.literal("agent_skill"),
  scope: v.picklist(AGENT_SKILL_SCOPES),
  ...skillPackFileMetadataSchema,
});

const presignBodySchema = v.union([
  entityCreatePresignBodySchema,
  entityVersionPresignBodySchema,
  agentSkillPresignBodySchema,
]);

type PresignBody = v.InferOutput<typeof presignBodySchema>;

const toPurposeData = (purposeBody: PresignBody): PresignPurposeData => {
  if (purposeBody.purpose === "entity_create") {
    const purposeData: PresignPurposeData = {
      type: "entity_create",
      propertyId: purposeBody.propertyId,
      parentId: purposeBody.parentId ?? null,
      ...(purposeBody.preview === undefined
        ? {}
        : { clientPreview: purposeBody.preview }),
      ...(purposeBody.importOrigin === undefined
        ? {}
        : {
            importSource: importDocumentSource({
              origin: purposeBody.importOrigin,
              contentHash: purposeBody.sha256Hex,
            }),
          }),
    };
    return purposeData;
  }
  if (purposeBody.purpose === "entity_version") {
    return {
      type: "entity_version",
      entityId: purposeBody.entityId,
      ...(purposeBody.preview === undefined
        ? {}
        : { clientPreview: purposeBody.preview }),
    };
  }
  return { type: "agent_skill", scope: purposeBody.scope };
};

const config = {
  contract: "patch",
  description:
    "Step 1 of 3 of the file-upload flow: reserve an upload and mint a " +
    "short-lived presigned S3 PUT URL. This is the ONLY way to get a file " +
    "into stella from an agent surface; the multipart endpoints cannot be " +
    "called with JSON. Pass purpose plus the file metadata: name, mimeType, " +
    "size in bytes, and sha256Hex (lowercase hex SHA-256 of the exact " +
    "bytes). purpose is entity_create (with propertyId, optional parentId, " +
    "and optional importOrigin to keep an imported file's source, id, " +
    "original dates and author) to add a new document, entity_version (with entityId) to add a version " +
    "to an existing one, or agent_skill (with scope team or private) for a " +
    "skill pack. Returns uploadId, url, expiresAt, and headers. Step 2: PUT " +
    "the bytes to url with those headers verbatim -- the URL is signed " +
    "against the exact size and checksum, so any deviation is rejected. " +
    "Step 3: call uploads.update with the uploadId to commit the record. " +
    "Apps that decode a HEIC/HEIF photo themselves may also pass preview " +
    "(mimeType image/jpeg or image/webp, size, sha256Hex, and its upright " +
    "width and height, at most 8 MP) and PUT that rendering to preview.url " +
    "with preview.headers before step 3; the server checks it and renders " +
    "the photo's preview from it. " +
    "Call uploads.delete instead if the PUT fails.",
  // permissions-exempt: the static gate is workspace:read because the
  // resource-appropriate grant depends on the request's purpose, which
  // authorizeUploadPurpose (uploads/permissions.ts) checks in-handler.
  permissions: uploadRoutePermission,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "file_transport",
    consumesServices: false,
  },
  body: presignBodySchema,
} satisfies WorkspaceHandlerConfig;

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
    const consent = authorizeUploadConsent({
      grantedScopes: session.grantedScopes,
      purpose: purposeBody.purpose,
    });
    if (Result.isError(consent)) {
      return Result.err(consent.error);
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

    return yield* reservePresignedUpload({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      purposeData: toPurposeData(purposeBody),
      file: purposeBody,
    });
  },
);

export default presignUpload;
