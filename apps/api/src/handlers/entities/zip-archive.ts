// Pure helpers for streaming a folder subtree as a ZIP archive.
// `download-zip.ts` wires these to the database, S3, and `client-zip`.

import { compareCodeUnit } from "@stll/collation";

import { sanitizeFilename } from "@/api/lib/sanitize-filename";

/** A folder descendant, with the fields needed to rebuild the tree. */
export type ArchiveNode = {
  id: string;
  parentId: string;
  kind: string;
  name: string;
};

type BuildArchivePathsArgs = {
  rootId: string;
  rootName: string;
  nodes: readonly ArchiveNode[];
};

// Deterministic archive entry order (id/name fields as stable sort keys, not
// linguistic sorting) so the same subtree always streams identically.
const compareArchiveNode = (a: ArchiveNode, b: ArchiveNode): number =>
  compareCodeUnit(a.parentId, b.parentId) ||
  compareCodeUnit(sanitizeFilename(a.name), sanitizeFilename(b.name)) ||
  compareCodeUnit(a.id, b.id);

const uniqueSegment = (seen: Set<string>, segment: string): string => {
  if (!seen.has(segment)) {
    seen.add(segment);
    return segment;
  }

  let n = 2;
  while (seen.has(`${segment} (${n})`)) {
    n++;
  }
  const unique = `${segment} (${n})`;
  seen.add(unique);
  return unique;
};

/**
 * Map every descendant entity id — and the root id — to its archive
 * path. Paths are rooted at the folder's own (sanitized) name so the
 * `.zip` unpacks into a folder rather than loose files. Every segment is
 * sanitized and same-named sibling folders receive a deterministic suffix. The
 * `parentId` chain is walked once and memoised. A node whose parent is
 * missing, or a `parentId` cycle, falls back to the root so a malformed
 * tree cannot recurse without end.
 */
export const buildArchivePaths = ({
  rootId,
  rootName,
  nodes,
}: BuildArchivePathsArgs): Map<string, string> => {
  const sanitizedRoot = sanitizeFilename(rootName);
  const orderedNodes = nodes.toSorted(compareArchiveNode);

  const nodeById = new Map<string, ArchiveNode>();
  for (const node of orderedNodes) {
    nodeById.set(node.id, node);
  }

  const paths = new Map<string, string>();
  const seenFolderSegmentsByParentId = new Map<string, Set<string>>();
  paths.set(rootId, sanitizedRoot);
  const resolving = new Set<string>();

  const resolve = (id: string): string => {
    const cached = paths.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const node = nodeById.get(id);
    if (node === undefined || resolving.has(id)) {
      paths.set(id, sanitizedRoot);
      return sanitizedRoot;
    }
    resolving.add(id);
    const sanitizedSegment = sanitizeFilename(node.name);
    if (node.kind !== "folder") {
      const path = `${resolve(node.parentId)}/${sanitizedSegment}`;
      resolving.delete(id);
      paths.set(id, path);
      return path;
    }

    const seenSegments =
      seenFolderSegmentsByParentId.get(node.parentId) ?? new Set();
    seenFolderSegmentsByParentId.set(node.parentId, seenSegments);
    const segment = uniqueSegment(seenSegments, sanitizedSegment);
    const path = `${resolve(node.parentId)}/${segment}`;
    resolving.delete(id);
    paths.set(id, path);
    return path;
  };

  for (const node of orderedNodes) {
    resolve(node.id);
  }
  return paths;
};

/**
 * Make `path` unique within `seen` by inserting " (n)" before the file
 * extension. Entity names are not unique, so two files can legitimately
 * share a directory; a collision must rename rather than overwrite.
 */
export const uniquePath = (seen: Set<string>, path: string): string => {
  if (!seen.has(path)) {
    seen.add(path);
    return path;
  }

  const slashIndex = path.lastIndexOf("/");
  const dotIndex = path.lastIndexOf(".");
  // The dot must sit inside the file name, with at least one character
  // before it — otherwise it is a directory dot or a leading-dot name.
  const hasExtension = dotIndex > slashIndex + 1;
  const base = hasExtension ? path.slice(0, dotIndex) : path;
  const extension = hasExtension ? path.slice(dotIndex) : "";

  let n = 2;
  while (seen.has(`${base} (${n})${extension}`)) {
    n++;
  }
  const unique = `${base} (${n})${extension}`;
  seen.add(unique);
  return unique;
};

/** An uploaded file held by a document descendant. */
export type ArchiveFileContent = {
  fileId: string;
  fileName: string;
  mimeType: string;
};

/**
 * Group uploaded files by the id of the document that holds them. A
 * document can carry several file fields, so each id maps to a list;
 * documents without one are absent rather than mapped to an empty list.
 */
export const groupFileContentsByEntityId = (
  files: readonly { entityId: string; content: ArchiveFileContent }[],
): Map<string, ArchiveFileContent[]> => {
  const contentsByEntityId = new Map<string, ArchiveFileContent[]>();
  for (const { entityId, content } of files) {
    const contents = contentsByEntityId.get(entityId);
    // Absent means "no file seen for this document yet", the normal state
    // on first encounter, so start the list rather than treating the miss
    // as a violated invariant.
    if (contents === undefined) {
      contentsByEntityId.set(entityId, [content]);
      continue;
    }
    contents.push(content);
  }
  return contentsByEntityId;
};

/** Body of the in-archive notice listing files that could not be fetched. */
export const buildErrorManifest = (failedPaths: readonly string[]): string =>
  [
    "Some files could not be included in this archive.",
    "",
    `${failedPaths.length} file(s) failed to download and are missing:`,
    ...failedPaths.map((path) => `  - ${path}`),
    "",
    "Please try the download again. If the problem continues, contact support.",
    "",
  ].join("\n");
