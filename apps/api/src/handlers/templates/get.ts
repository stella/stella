import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const getTemplateParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

/** Presigned URL validity in seconds (15 min). */
const PRESIGN_EXPIRES_IN = 900;

const config = {
  permissions: { workspace: ["read"] },
  params: getTemplateParamsSchema,
} satisfies HandlerConfig;

const getTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const templateId = params.templateId;
    const organizationId = session.activeOrganizationId;

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const template = await tx.query.templates.findFirst({
          where: {
            id: { eq: templateId },
            organizationId: { eq: organizationId },
          },
          columns: {
            id: true,
            name: true,
            fileName: true,
            s3Key: true,
            sizeBytes: true,
            manifest: true,
            fieldCount: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (!template) {
          return null;
        }

        const presignedUrl = await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
          resourceId: templateId,
          s3Key: template.s3Key,
          expiresInSeconds: PRESIGN_EXPIRES_IN,
          fileName: template.fileName,
          metadata: { sizeBytes: template.sizeBytes },
        });

        const { s3Key: _s3Key, ...rest } = template;
        return { ...rest, presignedUrl };
      }),
    );

    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    return Result.ok(result);
  },
);

export default getTemplate;
