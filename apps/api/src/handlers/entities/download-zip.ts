import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import JSZip from "jszip";

import type { SafeDb } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

const downloadZipParamsSchema = workspaceParams({
  entityId: tSafeId("entity"),
});

type DownloadZipHandlerProps = {
  safeDb: SafeDb;
  entityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

// One descendant of the folder being archived. `kind` distinguishes
// folders (→ directory entries) from documents (→ files).
type DescendantRow = {
  id: SafeId<"entity">;
  parentId: SafeId<"entity">;
  kind: string;
  name: string;
};

type FileContent = {
  fileName: string;
  fileId: string;
  mimeType: string;
};

/**
 * Collect every descendant of `parentId` with the fields needed to
 * rebuild the folder tree, using a recursive CTE (single query).
 */
const collectDescendants = async (
  safeDb: SafeDb,
  parentId: SafeId<"entity">,
  workspaceId: SafeId<"workspace">,
) =>
  await safeDb((tx) =>
    tx.execute<DescendantRow>(sql`
    WITH RECURSIVE descendants AS (
      SELECT ${entities.id}, ${entities.parentId}, ${entities.kind}, ${entities.name}
      FROM ${entities}
      WHERE ${entities.parentId} = ${parentId}
        AND ${entities.workspaceId} = ${workspaceId}
      UNION ALL
      SELECT e.id, e.parent_id, e.kind, e.name
      FROM ${entities} e
      INNER JOIN descendants d ON e.parent_id = d.id
      WHERE e.workspace_id = ${workspaceId}
    )
    SELECT id, parent_id AS "parentId", kind, name FROM descendants
  `),
  );

// Append " (n)" before the extension until `path` is unique within the
// archive. Same-named files can legitimately share a directory because
// entity names are not unique, so collisions must not silently drop a file.
const uniquePath = (seen: Set<string>, path: string): string => {
  if (!seen.has(path)) {
    seen.add(path);
    return path;
  }
  const dotIndex = path.lastIndexOf(".");
  const slashIndex = path.lastIndexOf("/");
  const hasExtension = dotIndex > slashIndex + 1;
  const base = hasExtension ? path.slice(0, dotIndex) : path;
  const extension = hasExtension ? path.slice(dotIndex) : "";

  let n = 2;
  while (seen.has(`${base} (${n})${extension}`)) {
    n++;
  }
  const candidate = `${base} (${n})${extension}`;
  seen.add(candidate);
  return candidate;
};

const downloadZipHandler = async function* ({
  safeDb,
  entityId,
  organizationId,
  workspaceId,
}: DownloadZipHandlerProps) {
  const folderRows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: entities.id,
          kind: entities.kind,
          name: entities.name,
        })
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
    collectDescendants(safeDb, entityId, workspaceId),
  );

  // Look up file content for the document descendants in one query.
  const fileContentByEntityId = new Map<string, FileContent>();
  if (descendantRows.length > 0) {
    const descendantIds = descendantRows.map(({ id }) =>
      brandPersistedEntityId(String(id)),
    );
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            entityId: entityVersions.entityId,
            content: fields.content,
          })
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
    for (const row of rows) {
      if (row.content.type === "file") {
        fileContentByEntityId.set(String(row.entityId), {
          fileName: row.content.fileName,
          fileId: row.content.id,
          mimeType: row.content.mimeType,
        });
      }
    }
  }

  // Rebuild the tree → archive paths, rooted at the folder's own name so
  // the downloaded `.zip` unpacks into a folder rather than loose files.
  const rootName = sanitizeFilename(folder.name);
  const nodeById = new Map<string, DescendantRow>();
  for (const row of descendantRows) {
    nodeById.set(String(row.id), row);
  }

  const pathCache = new Map<string, string>();
  // Archive path of an entity used as a directory. A parent id outside the
  // descendant set is the root folder itself.
  const dirPathOf = (id: string): string => {
    const cached = pathCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const node = nodeById.get(id);
    const path =
      node === undefined
        ? rootName
        : `${dirPathOf(String(node.parentId))}/${sanitizeFilename(node.name)}`;
    pathCache.set(id, path);
    return path;
  };

  const zip = new JSZip();
  // Register the root, then every folder, so empty folders survive.
  zip.folder(rootName);
  for (const node of descendantRows) {
    if (node.kind === "folder") {
      zip.folder(dirPathOf(String(node.id)));
    }
  }

  // Stream each file from S3 into its directory.
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  for (const node of descendantRows) {
    const file = fileContentByEntityId.get(String(node.id));
    if (file === undefined) {
      continue;
    }

    const key = createFileKey({
      organizationId,
      workspaceId,
      fileId: file.fileId,
      mimeType: file.mimeType,
    });

    const presignedUrl = getS3().presign(key, { expiresIn: 900 });
    const response = await fetch(presignedUrl, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      errors.push(file.fileId);
      continue;
    }

    const blob = await response.arrayBuffer();
    const directory = dirPathOf(String(node.parentId));
    const path = uniquePath(
      seenPaths,
      `${directory}/${sanitizeFilename(file.fileName)}`,
    );
    zip.file(path, blob);
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
