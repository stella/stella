import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { templates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";

type DeleteTemplateProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
};

export const deleteTemplateHandler = async ({
  organizationId,
  templateId,
}: DeleteTemplateProps) => {
  const existing = await db.query.templates.findFirst({
    where: { id: templateId, organizationId },
    columns: { id: true, s3Key: true },
  });

  if (!existing) {
    return status(404, { message: "Template not found" });
  }

  await db
    .delete(templates)
    .where(
      and(
        eq(templates.id, templateId),
        eq(templates.organizationId, organizationId),
      ),
    );

  // Delete S3 object outside the transaction to keep
  // DB operations short. If this fails, the file becomes
  // orphaned but that is safer than a dangling DB row.
  await s3.delete(existing.s3Key);

  return;
};
