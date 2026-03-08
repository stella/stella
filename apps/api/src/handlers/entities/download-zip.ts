import { and, eq, inArray, sql } from "drizzle-orm";
import { status } from "elysia";
import JSZip from "jszip";

import { db } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { captureError } from "@/api/lib/posthog";
import { s3 } from "@/api/lib/s3";

type DownloadZipHandlerProps = {
  entityId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type FileRow = {
  fileName: string;
  fileId: string;
  mimeType: string;
};

/**
 * Collect all descendant entity IDs of a folder using a
 * recursive CTE (single query, no N+1).
 */
const collectDescendantIds = async (
  parentId: string,
  workspaceId: SafeId<"workspace">,
): Promise<string[]> => {
  const result = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT ${entities.id}
      FROM ${entities}
      WHERE ${entities.parentId} = ${parentId}
        AND ${entities.workspaceId} = ${workspaceId}
      UNION ALL
      SELECT e.id
      FROM ${entities} e
      INNER JOIN descendants d ON e.parent_id = d.id
      WHERE e.workspace_id = ${workspaceId}
    )
    SELECT id FROM descendants
  `);

  return result.rows.map((r) => r.id);
};

export const downloadZipHandler = async ({
  entityId,
  organizationId,
  workspaceId,
}: DownloadZipHandlerProps) => {
  const [folder] = await db
    .select({ id: entities.id, kind: entities.kind })
    .from(entities)
    .where(
      and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
    )
    .limit(1);

  if (!folder) {
    return status(404);
  }

  if (folder.kind !== "folder") {
    return status(400);
  }

  const descendantIds = await collectDescendantIds(entityId, workspaceId);

  if (descendantIds.length === 0) {
    return status(404);
  }

  // Batch-query all file fields in one query
  const rows = await db
    .select({ content: fields.content })
    .from(fields)
    .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
    .innerJoin(
      entities,
      and(
        eq(entityVersions.entityId, entities.id),
        eq(entityVersions.id, entities.currentVersionId),
        eq(entities.workspaceId, workspaceId),
      ),
    )
    .where(inArray(entityVersions.entityId, descendantIds));

  const fileRows: FileRow[] = [];
  for (const row of rows) {
    if (row.content.type === "file") {
      fileRows.push({
        fileName: row.content.fileName,
        fileId: row.content.id,
        mimeType: row.content.mimeType,
      });
    }
  }

  if (fileRows.length === 0) {
    return status(404);
  }

  // Build ZIP — stream each file from S3 individually
  const zip = new JSZip();
  const seenNames = new Map<string, number>();
  const errors: string[] = [];

  for (const file of fileRows) {
    const key = createFileKey({
      organizationId,
      workspaceId,
      fileId: file.fileId,
      mimeType: file.mimeType,
    });

    const presignedUrl = s3.presign(key, { expiresIn: 900 });
    const response = await fetch(presignedUrl, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      errors.push(file.fileId);
      continue;
    }

    const blob = await response.arrayBuffer();

    // Deduplicate file names — loop until the candidate is unique
    let fileName = file.fileName;
    if (seenNames.has(fileName)) {
      let n = seenNames.get(fileName) ?? 1;
      let candidate: string;
      const dotIdx = fileName.lastIndexOf(".");
      do {
        n++;
        candidate =
          dotIdx > 0
            ? `${fileName.slice(0, dotIdx)} (${n})${fileName.slice(dotIdx)}`
            : `${fileName} (${n})`;
      } while (seenNames.has(candidate));
      seenNames.set(file.fileName, n);
      fileName = candidate;
    }
    seenNames.set(fileName, 1);

    zip.file(fileName, blob);
  }

  if (errors.length > 0) {
    captureError(
      new Error(`${errors.length} file(s) failed to fetch from S3`),
      { fileIds: errors.join(","), entityId },
    );
  }

  const zipBuffer = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return new Response(zipBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="folder.zip"',
    },
  });
};
