import presignUpload from "@/api/handlers/uploads/create";
import abortUpload from "@/api/handlers/uploads/delete";
import { saveDesktopDictationTranscriptAudio } from "@/api/handlers/uploads/desktop-transcript-audio";
import entityCreateTree from "@/api/handlers/uploads/entity-create-tree";
import preflightEntityCreate from "@/api/handlers/uploads/preflight-entity-create";
import finalizeUpload from "@/api/handlers/uploads/update";
import { routes } from "@/api/http/route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

/**
 * Workspace-scoped presigned-upload coordination:
 *
 *   POST /uploads/:workspaceId/presign
 *        body: { purpose, propertyId, parentId, name, mimeType, size, sha256Hex }
 *        → { uploadId, url, expiresAt, headers }
 *
 *   POST /uploads/:workspaceId/entity-create/preflight
 *        body: { entityCount, propertyId?, parentId?, sha256Hexes? }
 *        → { ok: true, duplicates } // documents here with the same bytes
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
 * All four share the legacy `upload` rate-limit budget — they
 * collectively represent one "upload" worth of API capacity.
 * Semantic resource updates run after entity tree creation and finalize so
 * entity and file projections refresh after durable writes.
 */
export const uploadsRoute = routes(
  {
    "/presign": { POST: presignUpload },
    "/entity-create/preflight": { POST: preflightEntityCreate },
    "/entity-create/tree": { POST: entityCreateTree },
    "/:uploadId/finalize": { POST: finalizeUpload },
    "/:uploadId/abort": { POST: abortUpload },
  },
  {
    prefix: "/uploads/:workspaceId",
    middleware: [
      rateLimit({
        duration: API_RATE_LIMITS.upload.duration,
        max: API_RATE_LIMITS.upload.max,
        budget: { name: "api.upload.address", keyKind: "address" },
        ...createRedisRateLimit({
          failurePolicy: "fail_open_local",
          scope: "upload-presigned",
        }),
      }),
    ],
  },
);

/** A linked desktop finalizes the recording it uploaded into a transcript's
 *  folder. It authenticates with its account key and device proof, so the
 *  route sits beside the other desktop dictation routes, under the same
 *  standard rate limit, not under a session. */
export const desktopDictationTranscriptAudioRoute = routes(
  {
    "/transcripts/audio": { POST: saveDesktopDictationTranscriptAudio },
  },
  {
    prefix: "/v1/desktop/dictation",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
