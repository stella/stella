import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";
import { nanoid } from "nanoid";

import type { ScopedDb } from "@/api/db";
import { templates, templateVersions } from "@/api/db/schema";
import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";
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
  scopedDb: ScopedDb;
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
  scopedDb,
  organizationId,
  userId,
  templateId,
  body,
}: UpdateTemplateProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: templateId, organizationId: { eq: organizationId } },
      columns: {
        id: true,
        s3Key: true,
        currentVersion: true,
      },
    }),
  );

  if (!existing) {
    return status(404, { message: "Template not found" });
  }

  const categoryId = body.categoryId;
  if (categoryId !== undefined && categoryId !== null) {
    const category = await scopedDb((tx) =>
      tx.query.templateCategories.findFirst({
        where: { id: categoryId, organizationId: { eq: organizationId } },
        columns: { id: true },
      }),
    );
    if (!category) {
      return status(400, { message: "Category not found" });
    }
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
  }> = {
    ...pickDefined(body, ["name", "categoryId"]),
    updatedAt: new Date(),
  };

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

    // Advisory lock + version count + update + insert in one
    // transaction to prevent TOCTOU on the version limit.
    const row = await scopedDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
      );

      const versionCount = await tx.$count(
        templateVersions,
        eq(templateVersions.templateId, templateId),
      );

      if (versionCount >= LIMITS.templateVersionsPerTemplate) {
        return null;
      }

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

    if (!row) {
      return status(400, {
        message: "Version limit reached for this template",
      });
    }

    return row;
  }

  const [updated] = await scopedDb((tx) =>
    tx
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
      }),
  );

  return updated;
};
