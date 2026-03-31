import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { s3 } from "@/api/lib/s3";

export const getTemplateParamsSchema = t.Object({
  templateId: tNanoid,
});

type GetTemplateProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: string;
};

/** Presigned URL validity in seconds (15 min). */
const PRESIGN_EXPIRES_IN = 900;

export const getTemplateHandler = async ({
  scopedDb,
  organizationId,
  templateId,
}: GetTemplateProps) => {
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: templateId, organizationId: { eq: organizationId } },
      columns: {
        id: true,
        name: true,
        fileName: true,
        s3Key: true, // needed for presigning, excluded below
        sizeBytes: true,
        manifest: true,
        fieldCount: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const presignedUrl = s3.presign(template.s3Key, {
    expiresIn: PRESIGN_EXPIRES_IN,
  });

  const { s3Key: _, ...rest } = template;

  return {
    ...rest,
    presignedUrl,
  };
};

const config = {
  permissions: { workspace: ["read"] },
  params: getTemplateParamsSchema,
} satisfies HandlerConfig;

const getTemplate = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await getTemplateHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    }),
);

export default getTemplate;
