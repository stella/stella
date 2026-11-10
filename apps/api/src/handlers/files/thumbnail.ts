import { Result } from "better-result";

import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import { status } from "@/api/http/status";
import type { HttpStatusResponse } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type {
  SafeHandlerGenerator,
  WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { ownerSyntheticSessionAuthorityReader } from "@/api/lib/auth";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { lockLiveVersionField } from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import { callerDownloadSource } from "@/api/lib/s3-presign";

/**
 * Each thumbnail redirect is authorized and audited against the current
 * session, and redirects are never cached. The client follows the redirect at
 * once, so the signed URL only has to outlive that hop: a link stops working
 * shortly after its version does.
 */
const FILE_THUMBNAIL_URL_EXPIRY_SECONDS = 60;

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "upload_mechanics" },
  access: "read",
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
} satisfies WorkspaceHandlerConfig;

/**
 * Redirect to the WebP thumbnail of a matter image file.
 *
 * The field is resolved through the same workspace-bound, tombstone-excluding
 * lookup as the file itself, so a field from another matter answers 404, and
 * stays locked against a tombstone until the link is signed. A file without a
 * generated thumbnail, or an encrypted one, answers 404 too.
 *
 * @yields Structured errors from thumbnail lookup or URL signing.
 */
export default createSafeHandler(
  config,
  async function* ({
    params: { fieldId },
    session,
    user,
    recordAuditEvent,
    scopedDb,
    workspaceId,
  }): SafeHandlerGenerator<Response | HttpStatusResponse<404, string>> {
    const organizationId = session.activeOrganizationId;
    // The lookup holds the version's share lock through the signature, so a
    // tombstone either commits before the lookup (404) or waits until the
    // link is signed and audited.
    const presignedUrl = yield* Result.await(
      Result.tryPromise(
        async () =>
          await scopedDb(async (tx) => {
            const row = await lockLiveVersionField(tx, fieldId, workspaceId);
            if (row?.content.type !== "file") {
              return null;
            }
            const { thumbnailFileId, encrypted } = row.content;
            if (!thumbnailFileId || encrypted) {
              return null;
            }
            return await auditedPresignDownload({
              readSessionAuthority: ownerSyntheticSessionAuthorityReader,
              tx,
              recordAuditEvent,
              resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              resourceId: row.entityId,
              userId: user.id,
              source: callerDownloadSource(session),
              s3Key: createFileKey({
                organizationId,
                workspaceId,
                fileId: thumbnailFileId,
                mimeType: THUMBNAIL_MIME_TYPE,
              }),
              expiresInSeconds: FILE_THUMBNAIL_URL_EXPIRY_SECONDS,
              organizationId,
              workspaceId,
              metadata: { fieldId, variant: "thumbnail" },
            });
          }),
      ),
    );
    if (presignedUrl === null) {
      return Result.ok(status(404));
    }

    return Result.ok(
      new Response(null, {
        status: 302,
        headers: {
          Location: presignedUrl,
          [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL,
        },
      }),
    );
  },
);
