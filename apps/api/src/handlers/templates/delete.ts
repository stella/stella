import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templates } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { s3 } from "@/api/lib/s3";

export const deleteTemplateParamsSchema = t.Object({
  templateId: tNanoid,
});

type DeleteTemplateProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: string;
};

export const deleteTemplateHandler = async ({
  scopedDb,
  organizationId,
  templateId,
}: DeleteTemplateProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: templateId, organizationId: { eq: organizationId } },
      columns: { id: true, s3Key: true },
      with: {
        versions: { columns: { s3Key: true } },
      },
    }),
  );

  if (!existing) {
    return status(404, { message: "Template not found" });
  }

  // Collect all S3 keys (current + historical versions)
  // before the cascade delete removes the version rows.
  const s3Keys = new Set<string>();
  s3Keys.add(existing.s3Key);
  for (const v of existing.versions) {
    s3Keys.add(v.s3Key);
  }

  await scopedDb((tx) =>
    tx
      .delete(templates)
      .where(
        and(
          eq(templates.id, templateId),
          eq(templates.organizationId, organizationId),
        ),
      ),
  );

  // Delete S3 objects outside the transaction to keep
  // DB operations short. If any delete fails, files become
  // orphaned but that is safer than a dangling DB row.
  for (const key of s3Keys) {
    s3.delete(key).catch(captureError);
  }

  return;
};

const config = {
  permissions: { template: ["delete"] },
  params: deleteTemplateParamsSchema,
} satisfies HandlerConfig;

const deleteTemplate = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await deleteTemplateHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    }),
);

export default deleteTemplate;
