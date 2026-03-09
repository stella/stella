import { desc, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { templateVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { presignDownloadUrl } from "@/api/lib/s3";

// ── Helpers ──────────────────────────────────────────

const verifyTemplateOwnership = async (
  templateId: string,
  organizationId: SafeId<"organization">,
) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId: { eq: organizationId } },
    columns: { id: true },
  });

  return template;
};

// ── List versions ────────────────────────────────────

type ListVersionsProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
};

export const listTemplateVersionsHandler = async ({
  organizationId,
  templateId,
}: ListVersionsProps) => {
  const template = await verifyTemplateOwnership(templateId, organizationId);

  if (!template) {
    return status(404, {
      message: "Template not found",
    });
  }

  const versions = await db
    .select({
      id: templateVersions.id,
      version: templateVersions.version,
      fieldCount: templateVersions.fieldCount,
      createdAt: templateVersions.createdAt,
    })
    .from(templateVersions)
    .where(eq(templateVersions.templateId, templateId))
    .orderBy(desc(templateVersions.version))
    .limit(LIMITS.templateVersionsPerTemplate);

  return { versions };
};

// ── Get version ──────────────────────────────────────

type GetVersionProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
  versionId: string;
};

export const getTemplateVersionHandler = async ({
  organizationId,
  templateId,
  versionId,
}: GetVersionProps) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId: { eq: organizationId } },
    columns: { id: true, fileName: true },
  });

  if (!template) {
    return status(404, {
      message: "Template not found",
    });
  }

  const version = await db.query.templateVersions.findFirst({
    where: { id: versionId, templateId },
    columns: {
      id: true,
      version: true,
      s3Key: true,
      fieldCount: true,
      createdAt: true,
    },
  });

  if (!version) {
    return status(404, {
      message: "Version not found",
    });
  }

  const downloadUrl = await presignDownloadUrl(version.s3Key, {
    expiresIn: 3600,
    fileName: template.fileName,
  });

  return {
    id: version.id,
    version: version.version,
    fieldCount: version.fieldCount,
    createdAt: version.createdAt,
    downloadUrl,
  };
};
