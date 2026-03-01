import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { templates } from "@/api/db/schema";
import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { s3 } from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";

export const updateTemplateBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  manifest: t.Optional(t.String()),
});

type UpdateTemplateBody = Static<typeof updateTemplateBodySchema>;

type UpdateTemplateProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
  body: UpdateTemplateBody;
};

const parseManifest = (json: string): TemplateManifest | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }
  if (!("version" in parsed) || typeof parsed.version !== "number") {
    return null;
  }
  if (!("fields" in parsed) || !Array.isArray(parsed.fields)) {
    return null;
  }
  if (!("conditions" in parsed) || !Array.isArray(parsed.conditions)) {
    return null;
  }

  return parsed as TemplateManifest;
};

export const updateTemplateHandler = async ({
  organizationId,
  templateId,
  body,
}: UpdateTemplateProps) => {
  const existing = await db.query.templates.findFirst({
    where: { id: templateId, organizationId },
    columns: { id: true, s3Key: true },
  });

  if (!existing) {
    return status(404, { message: "Template not found" });
  }

  const updates: Partial<{
    name: string;
    manifest: TemplateManifest;
    fieldCount: number;
    sizeBytes: number;
    updatedAt: Date;
  }> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    updates.name = body.name;
  }

  if (body.manifest !== undefined) {
    const manifest = parseManifest(body.manifest);
    if (!manifest) {
      return status(400, {
        message: "Invalid manifest JSON",
      });
    }

    // Re-embed the manifest in the DOCX so the S3 file
    // stays in sync with the DB.
    const docxBuffer = await s3.file(existing.s3Key).arrayBuffer();
    const updatedDocx = await writeManifest(Buffer.from(docxBuffer), manifest);
    await s3.write(existing.s3Key, new Uint8Array(updatedDocx));

    updates.manifest = manifest;
    updates.fieldCount = manifest.fields.length;
    updates.sizeBytes = updatedDocx.byteLength;
  }

  const [updated] = await db
    .update(templates)
    .set(updates)
    .where(
      and(
        eq(templates.id, templateId),
        eq(templates.organizationId, organizationId),
      ),
    )
    .returning({
      id: templates.id,
      name: templates.name,
      fieldCount: templates.fieldCount,
      updatedAt: templates.updatedAt,
    });

  return updated;
};
