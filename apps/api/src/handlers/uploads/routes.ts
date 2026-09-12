import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import presignUpload from "@/api/handlers/uploads/create";
import abortUpload from "@/api/handlers/uploads/delete";
import entityCreateTree from "@/api/handlers/uploads/entity-create-tree";
import preflightEntityCreate from "@/api/handlers/uploads/preflight-entity-create";
import reconcileUpload from "@/api/handlers/uploads/reconcile";
import finalizeUpload from "@/api/handlers/uploads/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const entityUploadRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.USER_FILE,
]);

/**
 * Workspace-scoped presigned-upload coordination:
 *
 *   POST /uploads/:workspaceId/presign
 *        body: { purpose, propertyId, parentId, name, mimeType, size, sha256Hex }
 *        → { uploadId, url, expiresAt, headers }
 *
 *   POST /uploads/:workspaceId/entity-create/preflight
 *        body: { entityCount, propertyId?, parentId? }
 *        → { ok: true }
 *
 *   POST /uploads/:workspaceId/entity-create/tree
 *        body: { propertyId?, parentId?, directories, files }
 *        → { directories, files } // folders committed; files reserved + signed
 *
 *   POST /uploads/:workspaceId/:uploadId/finalize
 *        → { finalizedResult }   // see PendingUploadFinalizedResult
 *
 *   POST /uploads/:workspaceId/:uploadId/abort
 *        → { ok: true }
 *
 *   POST /uploads/:workspaceId/:uploadId/reconcile
 *        → { state, ...stateData } // email_ingest only
 *
 * All routes share the legacy `upload` rate-limit budget: they
 * collectively represent one "upload" worth of API capacity.
 * Semantic resource updates run after entity tree creation and finalize so
 * entity and file projections refresh after durable writes.
 */
export const uploadsRoute = new Elysia({
  prefix: "/uploads/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "upload-presigned",
      }),
    }),
  )
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/presign", presignUpload.handler, {
    body: presignUpload.config.body,
    permissions: presignUpload.config.permissions,
  })
  .post("/entity-create/preflight", preflightEntityCreate.handler, {
    body: preflightEntityCreate.config.body,
    permissions: preflightEntityCreate.config.permissions,
  })
  .post("/entity-create/tree", entityCreateTree.handler, {
    body: entityCreateTree.config.body,
    resourceSetUpdated: entityUploadRealtimeUpdates,
    permissions: entityCreateTree.config.permissions,
  })
  .post("/:uploadId/finalize", finalizeUpload.handler, {
    body: finalizeUpload.config.body,
    params: finalizeUpload.config.params,
    resourceSetUpdated: entityUploadRealtimeUpdates,
    permissions: finalizeUpload.config.permissions,
  })
  .post("/:uploadId/abort", abortUpload.handler, {
    body: abortUpload.config.body,
    params: abortUpload.config.params,
    permissions: abortUpload.config.permissions,
  })
  .post("/:uploadId/reconcile", reconcileUpload.handler, {
    body: reconcileUpload.config.body,
    params: reconcileUpload.config.params,
    permissions: reconcileUpload.config.permissions,
  });
