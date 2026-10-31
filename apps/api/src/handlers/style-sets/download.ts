import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { styleSets } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { ownerSyntheticSessionAuthorityReader } from "@/api/lib/auth";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { storedKeyForOrganization } from "@/api/lib/file-key";
import { callerDownloadSource } from "@/api/lib/s3-presign";
import { STYLE_SET_DOWNLOAD_TTL_SECONDS } from "@/api/lib/style-sets";

const paramsSchema = v.object({ styleSetId: resourceIdSchema("styleSet") });
const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.standard,
  contentDelivery: { type: "audited" },
  description:
    "Mint a short-lived download URL for one organization style set's stored " +
    "DOCX package, recording the download in the audit trail. A style set " +
    "that is unknown or already deleted is a 404.",
  permissions: { styleSet: ["use"] },
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: paramsSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, user, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const [styleSet] = await tx
          .select({
            id: styleSets.id,
            fileName: styleSets.fileName,
            s3Key: styleSets.s3Key,
            sizeBytes: styleSets.sizeBytes,
          })
          .from(styleSets)
          .where(
            and(
              eq(styleSets.id, params.styleSetId),
              eq(styleSets.organizationId, session.activeOrganizationId),
              isNull(styleSets.deletedAt),
            ),
          )
          .limit(1);
        if (!styleSet) {
          return null;
        }
        const s3Key = storedKeyForOrganization(
          styleSet.s3Key,
          session.activeOrganizationId,
        );
        if (s3Key === null) {
          return null;
        }

        const presignedUrl = await auditedPresignDownload({
          readSessionAuthority: ownerSyntheticSessionAuthorityReader,
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
          resourceId: styleSet.id,
          userId: user.id,
          source: callerDownloadSource(session),
          s3Key,
          expiresInSeconds: STYLE_SET_DOWNLOAD_TTL_SECONDS,
          fileName: styleSet.fileName,
          organizationId: session.activeOrganizationId,
          metadata: { sizeBytes: styleSet.sizeBytes },
        });
        return { presignedUrl };
      }),
    );

    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Style set not found" }),
      );
    }
    return Result.ok(result);
  },
);
