import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { getTemplateVersionHandler } from "../versions";

const getTemplateVersionParamsSchema = t.Object({
  templateId: tSafeId("template"),
  versionId: tSafeId("templateVersion"),
});

const config = {
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
  async function* ({ scopedDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getTemplateVersionHandler({
            scopedDb,
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
