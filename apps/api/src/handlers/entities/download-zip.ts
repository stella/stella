import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import { t } from "elysia";
import JSZip from "jszip";

import type { SafeDb } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { s3 } from "@/api/lib/s3";

const downloadZipParamsSchema = t.Object({
  entityId: t.String(),
});

type DownloadZipHandlerProps = {
  safeDb: SafeDb;
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
  safeDb: SafeDb,
  parentId: string,
  workspaceId: SafeId<"workspace">,
) =>
  await safeDb((tx) =>
    tx.execute<{ id: string }>(sql`
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
  `),
  );

const downloadZipHandler = async function* ({
  safeDb,
  entityId,
  organizationId,
  workspaceId,
}: DownloadZipHandlerProps) {
  const folderRows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ id: entities.id, kind: entities.kind })
        .from(entities)
        .where(
          and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
        )
        .limit(1),
    ),
  );
  const folder = folderRows.at(0);

  if (!folder) {
    return Result.err(
      new HandlerError({ status: 404, message: "Folder not found" }),
    );
  }

  if (folder.kind !== "folder") {
    return Result.err(
      new HandlerError({ status: 400, message: "Entity is not a folder" }),
    );
  }

  const descendantRows = yield* Result.await(
    collectDescendantIds(safeDb, entityId, workspaceId),
  );

  // Drizzle's execute() erases the generic to Record<string, any>
  const descendantIds = descendantRows.map((r) => String(r.id));

  if (descendantIds.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Folder is empty" }),
    );
  }

  // Batch-query all file fields in one query
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ content: fields.content })
        .from(fields)
        .innerJoin(
          entityVersions,
          eq(fields.entityVersionId, entityVersions.id),
        )
        .innerJoin(
          entities,
          and(
            eq(entityVersions.entityId, entities.id),
            eq(entityVersions.id, entities.currentVersionId),
            eq(entities.workspaceId, workspaceId),
          ),
        )
        .where(inArray(entityVersions.entityId, descendantIds)),
    ),
  );

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
    return Result.err(
      new HandlerError({ status: 404, message: "No files found in folder" }),
    );
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

  return Result.ok(
    new Response(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="folder.zip"',
      },
    }),
  );
};

const config = {
  permissions: { workspace: ["read"] },
  params: downloadZipParamsSchema,
} satisfies HandlerConfig;

const downloadZip = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, params }) {
    return yield* downloadZipHandler({
      safeDb,
      entityId: params.entityId,
      organizationId: session.activeOrganizationId,
      workspaceId,
    });
  },
);

export default downloadZip;
