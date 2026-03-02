import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { templates, templateVersions } from "@/api/db/schema";
import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { s3 } from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";

const buildVersionS3Key = (
  organizationId: string,
  templateId: string,
  version: number,
) => `${organizationId}/templates/${templateId}/v${version}.docx`;

export const updateTemplateBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tNanoid)),
  manifest: t.Optional(t.String()),
});

type UpdateTemplateBody = Static<typeof updateTemplateBodySchema>;

type UpdateTemplateProps = {
  organizationId: SafeId<"organization">;
  userId: string;
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
  userId,
  templateId,
  body,
}: UpdateTemplateProps) => {
  const existing = await db.query.templates.findFirst({
    where: { id: templateId, organizationId },
    columns: {
      id: true,
      s3Key: true,
      currentVersion: true,
    },
  });

  if (!existing) {
    return status(404, { message: "Template not found" });
  }

  const updates: Partial<{
    name: string;
    categoryId: string | null;
    manifest: TemplateManifest;
    fieldCount: number;
    sizeBytes: number;
    s3Key: string;
    currentVersion: number;
    updatedAt: Date;
  }> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    updates.name = body.name;
  }
  if (body.categoryId !== undefined) {
    if (body.categoryId !== null) {
      const category = await db.query.templateCategories.findFirst({
        where: { id: body.categoryId, organizationId },
        columns: { id: true },
      });
      if (!category) {
        return status(400, { message: "Category not found" });
      }
    }
    updates.categoryId = body.categoryId;
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

    updates.manifest = manifest;
    updates.fieldCount = manifest.fields.length;
    updates.sizeBytes = updatedDocx.byteLength;

    // Bump version and create snapshot
    const versionCount = await db.$count(
      templateVersions,
      eq(templateVersions.templateId, templateId),
    );

    if (versionCount >= LIMITS.templateVersionsPerTemplate) {
      return status(400, {
        message: "Version limit reached for this template",
      });
    }

    const newVersion = existing.currentVersion + 1;
    updates.currentVersion = newVersion;

    // Each version gets its own immutable S3 key so
    // historical snapshots remain downloadable.
    const versionS3Key = buildVersionS3Key(
      organizationId,
      templateId,
      newVersion,
    );
    updates.s3Key = versionS3Key;

    // Write to the new version-specific key (outside
    // the transaction to keep it short).
    await s3.write(versionS3Key, new Uint8Array(updatedDocx));

    const row = await db.transaction(async (tx) => {
      const [r] = await tx
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

      await tx.insert(templateVersions).values({
        id: nanoid(),
        templateId,
        version: newVersion,
        s3Key: versionS3Key,
        manifest,
        fieldCount: manifest.fields.length,
        createdBy: userId,
      });

      return r;
    });

    return row;
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
