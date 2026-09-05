import { panic } from "better-result";
import { and, desc, eq, lt } from "drizzle-orm";
import { status } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { templateVersions } from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { extractText } from "@/api/lib/docx/extract-text";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { readS3ArrayBuffer } from "@/api/lib/s3";

/** Presigned download URLs expire after 15 minutes, matching every
 *  other read path (`templates/get.ts`, `files/read-by-id.ts`). */
const PRESIGN_EXPIRES_IN = 900;

export const TEMPLATE_VERSIONS_PAGE_SIZE_DEFAULT = 20;

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

const encodeVersionCursor = (version: number): string =>
  encodePaginationCursor([version]);

const decodeVersionCursor = (cursor: string): number | null => {
  const parts = decodePaginationCursor(cursor);
  const version = parts?.at(0);
  return typeof version === "number" && Number.isInteger(version) && version > 0
    ? version
    : null;
};

// ── List versions ────────────────────────────────────

type ListVersionsProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  cursor: string | undefined;
  limit: number;
};

export const listTemplateVersionsHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  cursor,
  limit,
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

  const cursorVersion =
    cursor === undefined ? null : decodeVersionCursor(cursor);
  if (cursor !== undefined && cursorVersion === null) {
    return status(400, {
      message: "Invalid cursor",
    });
  }

  const conditions = [eq(templateVersions.templateId, templateId)];
  if (cursorVersion !== null) {
    conditions.push(lt(templateVersions.version, cursorVersion));
  }

  // Author resolves through the org membership so names of users
  // outside the organization never leak; versions saved by departed
  // members simply show no author.
  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: templateVersions.id,
        version: templateVersions.version,
        fieldCount: templateVersions.fieldCount,
        createdAt: templateVersions.createdAt,
        authorName: user.name,
        authorImage: user.image,
      })
      .from(templateVersions)
      .leftJoin(
        member,
        and(
          eq(member.userId, templateVersions.createdBy),
          eq(member.organizationId, organizationId),
        ),
      )
      .leftJoin(user, eq(user.id, member.userId))
      .where(and(...conditions))
      .orderBy(desc(templateVersions.version))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodeVersionCursor(item.version),
  });

  return {
    items: page.items.map((row) => ({
      id: row.id,
      version: row.version,
      fieldCount: row.fieldCount,
      createdAt: row.createdAt,
      author:
        row.authorName === null
          ? null
          : { name: row.authorName, image: row.authorImage },
    })),
    nextCursor: page.nextCursor,
    limit: page.limit,
  };
};

// ── Get version ──────────────────────────────────────

type GetVersionProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  versionId: SafeId<"templateVersion">;
  recordAuditEvent: AuditRecorder;
};

export const getTemplateVersionHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  versionId,
  recordAuditEvent,
}: GetVersionProps) => {
  const result = await scopedDb(async (tx) => {
    const template = await tx.query.templates.findFirst({
      where: { id: { eq: templateId }, organizationId: { eq: organizationId } },
      columns: { id: true, fileName: true },
    });

    if (!template) {
      return { type: "template-not-found" as const };
    }

    const version = await tx.query.templateVersions.findFirst({
      where: { id: { eq: versionId }, templateId: { eq: templateId } },
      columns: {
        id: true,
        version: true,
        s3Key: true,
        fieldCount: true,
        createdAt: true,
      },
    });

    if (!version) {
      return { type: "version-not-found" as const };
    }

    const downloadUrl = await auditedPresignDownload({
      tx,
      recordAuditEvent,
      resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
      resourceId: templateId,
      s3Key: version.s3Key,
      expiresInSeconds: PRESIGN_EXPIRES_IN,
      fileName: template.fileName,
      organizationId,
      metadata: { versionId: version.id, version: version.version },
    });

    return {
      type: "found" as const,
      id: version.id,
      version: version.version,
      fieldCount: version.fieldCount,
      createdAt: version.createdAt,
      downloadUrl,
    };
  });

  switch (result.type) {
    case "found":
      return {
        id: result.id,
        version: result.version,
        fieldCount: result.fieldCount,
        createdAt: result.createdAt,
        downloadUrl: result.downloadUrl,
      };
    case "template-not-found":
      return status(404, { message: "Template not found" });
    case "version-not-found":
      return status(404, { message: "Version not found" });
    default: {
      result satisfies never;
      return panic(`Unhandled result: ${String(result)}`);
    }
  }
};

// ── Diff sources ─────────────────────────────────────

type TemplateVersionDiffSources =
  | { type: "not-found" }
  | { type: "ok"; prevText: string; currentText: string };

type DiffSourcesProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  versionId: SafeId<"templateVersion">;
};

const extractDocxText = async (buffer: ArrayBuffer): Promise<string> => {
  const extracted = await extractText(new Uint8Array(buffer));
  return extracted.paragraphs.map((p) => p.text).join("\n");
};

/**
 * Resolve a version and its predecessor to plain text for diffing.
 * Ownership is checked here so diff/summarize endpoints never touch
 * S3 content the caller's organization does not own. The first
 * version of a template diffs against the empty document.
 */
export const loadTemplateVersionDiffSources = async ({
  scopedDb,
  organizationId,
  templateId,
  versionId,
}: DiffSourcesProps): Promise<TemplateVersionDiffSources> => {
  const template = await verifyTemplateOwnership(
    scopedDb,
    templateId,
    organizationId,
  );
  if (!template) {
    return { type: "not-found" };
  }

  const version = await scopedDb((tx) =>
    tx.query.templateVersions.findFirst({
      where: { id: { eq: versionId }, templateId: { eq: templateId } },
      columns: { version: true, s3Key: true },
    }),
  );
  if (!version) {
    return { type: "not-found" };
  }

  const previous = await scopedDb((tx) =>
    tx
      .select({ s3Key: templateVersions.s3Key })
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.templateId, templateId),
          lt(templateVersions.version, version.version),
        ),
      )
      .orderBy(desc(templateVersions.version))
      .limit(1),
  );
  const previousS3Key = previous.at(0)?.s3Key ?? null;

  const [currentBuffer, prevBuffer] = await Promise.all([
    readS3ArrayBuffer(version.s3Key),
    previousS3Key === null
      ? Promise.resolve(null)
      : readS3ArrayBuffer(previousS3Key),
  ]);

  const [currentText, prevText] = await Promise.all([
    extractDocxText(currentBuffer),
    prevBuffer === null ? Promise.resolve("") : extractDocxText(prevBuffer),
  ]);

  return { type: "ok", prevText, currentText };
};
