import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { callerDownloadSource } from "@/api/lib/s3-presign";

import { getTemplateVersionHandler } from "../versions";

const getTemplateVersionParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
  versionId: resourceIdSchema("templateVersion"),
});

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  description:
    "Read one stored template version: its number, field count, creation " +
    "time, and a short-lived presigned URL to download that version's DOCX. " +
    "The download grant is recorded in the audit trail.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  access: "read",
  params: getTemplateVersionParamsSchema,
} satisfies HandlerConfig;

const getTemplateVersion = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, user, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getTemplateVersionHandler({
            scopedDb,
            userId: user.id,
            source: callerDownloadSource(session),
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
            versionId: params.versionId,
            recordAuditEvent,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(result);
  },
);

export default getTemplateVersion;
