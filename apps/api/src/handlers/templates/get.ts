import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { ownerSyntheticSessionAuthorityReader } from "@/api/lib/auth";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { storedKeyForOrganization } from "@/api/lib/file-key";
import { callerDownloadSource } from "@/api/lib/s3-presign";

const getTemplateParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
});

/** Presigned URL validity in seconds (15 min). */
const PRESIGN_EXPIRES_IN = 900;

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  description:
    "Read one template's record: name, file name, size, manifest, field " +
    "count, tags, languages, whenToUse and whenNotToUse guidance, usage " +
    "counters, and a short-lived presigned URL for its current DOCX. The " +
    "download grant is recorded in the audit trail.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_templates" },
  access: "read",
  params: getTemplateParamsSchema,
} satisfies HandlerConfig;

const getTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, user, recordAuditEvent }) {
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
            tags: true,
            languages: true,
            whenToUse: true,
            whenNotToUse: true,
            useCount: true,
            lastUsedAt: true,
            origin: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (!template) {
          return null;
        }
        const s3Key = storedKeyForOrganization(template.s3Key, organizationId);
        if (s3Key === null) {
          return null;
        }

        const presignedUrl = await auditedPresignDownload({
          readSessionAuthority: ownerSyntheticSessionAuthorityReader,
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
          resourceId: templateId,
          userId: user.id,
          source: callerDownloadSource(session),
          s3Key,
          expiresInSeconds: PRESIGN_EXPIRES_IN,
          fileName: template.fileName,
          organizationId,
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
