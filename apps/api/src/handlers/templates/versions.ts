import { desc, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templateVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { presignDownloadUrl } from "@/api/lib/s3";

/** Presigned download URLs expire after 15 minutes, matching every
 *  other read path (`templates/get.ts`, `files/read-by-id.ts`). */
const PRESIGN_EXPIRES_IN = 900;

// ── Helpers ──────────────────────────────────────────

const verifyTemplateOwnership = async (
  scopedDb: ScopedDb,
  templateId: SafeId<"template">,
  organizationId: SafeId<"organization">,
) => {
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: { eq: templateId }, organizationId: { eq: organizationId } },
      columns: { id: true },
    }),
  );

  return template;
};

// ── List versions ────────────────────────────────────

type ListVersionsProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
};

export const listTemplateVersionsHandler = async ({
  scopedDb,
  organizationId,
  templateId,
}: ListVersionsProps) => {
  const template = await verifyTemplateOwnership(
    scopedDb,
    templateId,
    organizationId,
  );

  if (!template) {
    return status(404, {
      message: "Template not found",
    });
  }

  const versions = await scopedDb((tx) =>
    tx
      .select({
        id: templateVersions.id,
        version: templateVersions.version,
        fieldCount: templateVersions.fieldCount,
        createdAt: templateVersions.createdAt,
      })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, templateId))
      .orderBy(desc(templateVersions.version))
      .limit(LIMITS.templateVersionsPerTemplate),
  );

  return { versions };
};

// ── Get version ──────────────────────────────────────

type GetVersionProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  versionId: SafeId<"templateVersion">;
};

export const getTemplateVersionHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  versionId,
}: GetVersionProps) => {
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: { eq: templateId }, organizationId: { eq: organizationId } },
      columns: { id: true, fileName: true },
    }),
  );

  if (!template) {
    return status(404, {
      message: "Template not found",
    });
  }

  const version = await scopedDb((tx) =>
    tx.query.templateVersions.findFirst({
      where: { id: { eq: versionId }, templateId: { eq: templateId } },
      columns: {
        id: true,
        version: true,
        s3Key: true,
        fieldCount: true,
        createdAt: true,
      },
    }),
  );

  if (!version) {
    return status(404, {
      message: "Version not found",
    });
  }

  const downloadUrl = presignDownloadUrl(version.s3Key, {
    expiresIn: PRESIGN_EXPIRES_IN,
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
