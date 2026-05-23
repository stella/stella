import { Result } from "better-result";
import { makeZip } from "client-zip";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import {
  buildArchivePaths,
  buildErrorManifest,
  mapOrderedConcurrent,
  uniquePath,
} from "@/api/handlers/entities/zip-archive";
import type { ArchiveNode } from "@/api/handlers/entities/zip-archive";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  FetchBoundaryError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

const downloadZipParamsSchema = workspaceParams({
  entityId: tSafeId("entity"),
});

// At most this many files are fetched from S3 at once. Bounds the
// archive's memory footprint (≈ this many files) and the load on storage.
const FETCH_CONCURRENCY = 6;
const PRESIGN_TTL_SECONDS = 900;
const FETCH_TIMEOUT_MS = 30_000;
const ERROR_MANIFEST_NAME = "_DOWNLOAD ERRORS.txt";

type DownloadZipHandlerProps = {
  safeDb: SafeDb;
  entityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

// A document descendant with an uploaded file, placed at `path`.
type ArchiveFile = {
  path: string;
  fileId: string;
  mimeType: string;
};

type FetchedFile =
  | { type: "file"; path: string; data: Uint8Array }
  | { type: "error"; path: string; fileId: string };

/**
 * Collect every descendant of `parentId` with the fields needed to
 * rebuild the folder tree, in one recursive CTE.
 */
const collectDescendants = async (
  safeDb: SafeDb,
  parentId: SafeId<"entity">,
  workspaceId: SafeId<"workspace">,
) =>
  await safeDb((tx) =>
    tx.execute<ArchiveNode>(sql`
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

const downloadZipHandler = async function* ({
  safeDb,
  entityId,
  organizationId,
  workspaceId,
}: DownloadZipHandlerProps) {
  const folderRows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ id: entities.id, kind: entities.kind, name: entities.name })
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

  const descendants = yield* Result.await(
    collectDescendants(safeDb, entityId, workspaceId),
  );

  // Uploaded-file content for the document descendants, in one query.
  const fileContentsByEntityId = new Map<
    string,
    { fileId: string; fileName: string; mimeType: string }[]
  >();
  if (descendants.length > 0) {
    const descendantIds = descendants.map((node) =>
      brandPersistedEntityId(node.id),
    );
    const fieldRows = yield* Result.await(
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
    for (const row of fieldRows) {
      if (row.content.type === "file") {
        const entityFileContents =
          fileContentsByEntityId.get(String(row.entityId)) ?? [];
        entityFileContents.push({
          fileId: row.content.id,
          fileName: row.content.fileName,
          mimeType: row.content.mimeType,
        });
        fileContentsByEntityId.set(String(row.entityId), entityFileContents);
      }
    }
  }

  // Rebuild the tree → archive paths, rooted at the folder's own name.
  const rootId = String(entityId);
  const paths = buildArchivePaths({
    rootId,
    rootName: folder.name,
    nodes: descendants,
  });
  const rootPath = paths.get(rootId) ?? sanitizeFilename(folder.name);
  const zipFileName = sanitizeFilename(`${rootPath.slice(0, 251)}.zip`);

  // Every folder becomes a directory entry, so empty folders survive.
  const folderPaths = [rootPath];
  for (const node of descendants) {
    if (node.kind !== "folder") {
      continue;
    }
    const path = paths.get(node.id);
    if (path !== undefined) {
      folderPaths.push(path);
    }
  }
  folderPaths.sort();

  // Order files, then de-duplicate, so the archive is deterministic
  // regardless of the recursive CTE's row order.
  const rawFiles = descendants.flatMap((node) => {
    const contents = fileContentsByEntityId.get(node.id);
    if (contents === undefined) {
      return [];
    }
    const directory = paths.get(node.parentId) ?? rootPath;
    return contents.map((content) => ({
      rawPath: `${directory}/${sanitizeFilename(content.fileName)}`,
      fileId: content.fileId,
      mimeType: content.mimeType,
    }));
  });
  rawFiles.sort(
    (a, b) =>
      a.rawPath.localeCompare(b.rawPath) || a.fileId.localeCompare(b.fileId),
  );

  const seenPaths = new Set<string>();
  const files: ArchiveFile[] = rawFiles.map((file) => ({
    path: uniquePath(seenPaths, file.rawPath),
    fileId: file.fileId,
    mimeType: file.mimeType,
  }));

  // --- Everything below runs lazily, as the response stream is consumed.

  const fetchFile = async (file: ArchiveFile): Promise<FetchedFile> => {
    const key = createFileKey({
      organizationId,
      workspaceId,
      fileId: file.fileId,
      mimeType: file.mimeType,
    });
    const presignedUrl = getS3().presign(key, {
      expiresIn: PRESIGN_TTL_SECONDS,
    });
    const fetched = await Result.tryPromise(async () => {
      const response = await fetch(presignedUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new FetchBoundaryError({
          url: presignedUrl,
          status: response.status,
          statusText: response.statusText,
          message: `storage responded ${response.status}`,
        });
      }
      return new Uint8Array(await response.arrayBuffer());
    });
    if (Result.isError(fetched)) {
      return { type: "error", path: file.path, fileId: file.fileId };
    }
    return { type: "file", path: file.path, data: fetched.value };
  };

  const archiveEntries = async function* () {
    for (const folderPath of folderPaths) {
      yield { name: `${folderPath}/` };
    }

    const failedPaths: string[] = [];
    const failedFileIds: string[] = [];
    for await (const result of mapOrderedConcurrent(
      files,
      FETCH_CONCURRENCY,
      fetchFile,
    )) {
      if (result.type === "error") {
        failedPaths.push(result.path);
        failedFileIds.push(result.fileId);
        continue;
      }
      yield { name: result.path, input: result.data };
    }

    // Failures surface in two places: a notice inside the archive so the
    // user sees what is missing, and telemetry (file ids only — never
    // names) so the failure is observable server-side.
    if (failedPaths.length > 0) {
      captureError(
        new Error(`${failedPaths.length} file(s) failed to fetch from S3`),
        { entityId, fileIds: failedFileIds.join(",") },
      );
      yield {
        name: uniquePath(seenPaths, `${rootPath}/${ERROR_MANIFEST_NAME}`),
        input: buildErrorManifest(failedPaths),
      };
    }
  };

  return Result.ok(
    new Response(makeZip(archiveEntries()), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(zipFileName),
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
