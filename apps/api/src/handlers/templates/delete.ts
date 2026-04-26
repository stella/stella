import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { templates } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

const deleteTemplateParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

type DeleteTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
};

const deleteTemplateHandler = async function* ({
  safeDb,
  organizationId,
  templateId,
}: DeleteTemplateProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.templates.findFirst({
        where: {
          id: { eq: templateId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, s3Key: true },
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

  yield* Result.await(
    safeDb((tx) =>
      tx
        .delete(templates)
        .where(
          and(
            eq(templates.id, templateId),
            eq(templates.organizationId, organizationId),
          ),
        ),
    ),
  );

  // Delete S3 objects outside the transaction to keep
  // DB operations short. If any delete fails, files become
  // orphaned but that is safer than a dangling DB row.
  for (const key of s3Keys) {
    getS3().delete(key).catch(captureError);
  }

  return Result.ok(undefined);
};

const config = {
  permissions: { template: ["delete"] },
  params: deleteTemplateParamsSchema,
} satisfies HandlerConfig;

const deleteTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* deleteTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    });
  },
);

export default deleteTemplate;
