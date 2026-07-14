import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const PRESIGN_EXPIRES_IN = 900;
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
        const styleSet = await tx.query.styleSets.findFirst({
          where: {
            id: { eq: params.styleSetId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            id: true,
            fileName: true,
            s3Key: true,
            sizeBytes: true,
          },
        });
        if (!styleSet) {
          return null;
        }

        const presignedUrl = await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
          resourceId: styleSet.id,
          s3Key: styleSet.s3Key,
          expiresInSeconds: PRESIGN_EXPIRES_IN,
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
