import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import { deleteS3Keys } from "@/api/handlers/files/utils";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteTemplateParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

type DeleteTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  recordAuditEvent: AuditRecorder;
};

const deleteTemplateHandler = async function* ({
  safeDb,
  organizationId,
  templateId,
  recordAuditEvent,
}: DeleteTemplateProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.templates.findFirst({
        where: {
          id: { eq: templateId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, name: true, s3Key: true },
        with: {
          versions: { columns: { s3Key: true } },
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  // Collect all S3 keys (current + historical versions)
  // before the cascade delete removes the version rows.
  const s3Keys = new Set<string>();
  s3Keys.add(existing.s3Key);
  for (const v of existing.versions) {
    s3Keys.add(v.s3Key);
  }

  Result.unwrap(
    await deleteS3Keys([...s3Keys]),
    "Template file cleanup must succeed before deleting database records",
  );

  yield* Result.await(
    safeDb(async (tx) => {
      await tx
        .delete(templates)
        .where(
          and(
            eq(templates.id, templateId),
            eq(templates.organizationId, organizationId),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId: null,
        changes: {
          deleted: {
            old: { name: existing.name, s3Key: existing.s3Key },
            new: null,
          },
        },
        metadata: { versionCount: existing.versions.length },
      });
    }),
  );

  return Result.ok({});
};

const config = {
  permissions: { template: ["delete"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: deleteTemplateParamsSchema,
} satisfies HandlerConfig;

const deleteTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    return yield* deleteTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      recordAuditEvent,
    });
  },
);

export default deleteTemplate;
