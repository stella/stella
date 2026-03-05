import { status } from "elysia";

import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";

type GetTemplateProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
};

/** Presigned URL validity in seconds (15 min). */
const PRESIGN_EXPIRES_IN = 900;

export const getTemplateHandler = async ({
  organizationId,
  templateId,
}: GetTemplateProps) => {
  const template = await db.query.templates.findFirst({
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
  });

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
