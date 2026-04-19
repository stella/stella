import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { s3 } from "@/api/lib/s3";

const getTemplateParamsSchema = t.Object({
  templateId: tNanoid,
});

type GetTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: string;
};

/** Presigned URL validity in seconds (15 min). */
const PRESIGN_EXPIRES_IN = 900;

const getTemplateHandler = async function* ({
  safeDb,
  organizationId,
  templateId,
}: GetTemplateProps) {
  const template = yield* Result.await(
    safeDb((tx) =>
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
    ),
  );

  if (!template) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const presignedUrl = s3.presign(template.s3Key, {
    expiresIn: PRESIGN_EXPIRES_IN,
  });

  const { s3Key: _, ...rest } = template;

  return Result.ok({
    ...rest,
    presignedUrl,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  params: getTemplateParamsSchema,
} satisfies HandlerConfig;

const getTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* getTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    });
  },
);

export default getTemplate;
