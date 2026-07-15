import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { STYLE_SET_DOWNLOAD_TTL_SECONDS } from "@/api/lib/style-sets";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const config = {
  permissions: { styleSet: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: paramsSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
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

        const presignedUrl = await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
          resourceId: styleSet.id,
          s3Key: styleSet.s3Key,
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
