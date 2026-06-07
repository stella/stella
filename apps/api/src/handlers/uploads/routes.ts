import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import abortUpload from "@/api/handlers/uploads/abort";
import finalizeUpload from "@/api/handlers/uploads/finalize";
import presignUpload from "@/api/handlers/uploads/presign";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit";

/**
 * Workspace-scoped presigned-upload coordination:
 *
 *   POST /uploads/:workspaceId/presign
 *        body: { purpose, propertyId, parentId, name, mimeType, size, sha256Hex }
 *        → { uploadId, url, expiresAt, headers }
 *
 *   POST /uploads/:workspaceId/:uploadId/finalize
 *        → { finalizedResult }   // see PendingUploadFinalizedResult
 *
 *   POST /uploads/:workspaceId/:uploadId/abort
 *        → { ok: true }
 *
 * All three share the legacy `upload` rate-limit budget — they
 * collectively represent one "upload" worth of API capacity.
 * `invalidateQuery` runs on finalize so the entities list cache
 * refreshes after a successful entity_create finalize, matching the
 * legacy multipart endpoint's behaviour.
 */
export const uploadsRoute = new Elysia({
  prefix: "/uploads/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
      generator: scopedGenerator("upload-presigned"),
      context: new InMemoryRateLimitContext(),
    }),
  )
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/presign", presignUpload.handler, {
    body: presignUpload.config.body,
    permissions: presignUpload.config.permissions,
  })
  .post("/:uploadId/finalize", finalizeUpload.handler, {
    params: finalizeUpload.config.params,
    invalidateQuery: true,
    permissions: finalizeUpload.config.permissions,
  })
  .post("/:uploadId/abort", abortUpload.handler, {
    params: abortUpload.config.params,
    permissions: abortUpload.config.permissions,
  });
