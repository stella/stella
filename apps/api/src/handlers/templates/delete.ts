import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { templates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { captureError } from "@/api/lib/posthog";
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
    with: {
      versions: { columns: { s3Key: true } },
    },
  });

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

  await db
    .delete(templates)
    .where(
      and(
        eq(templates.id, templateId),
        eq(templates.organizationId, organizationId),
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
