// Pure helpers for streaming a folder subtree as a ZIP archive.
// `download-zip.ts` wires these to the database, S3, and `client-zip`.

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

const compareArchiveNode = (a: ArchiveNode, b: ArchiveNode): number =>
  a.parentId.localeCompare(b.parentId) ||
  sanitizeFilename(a.name).localeCompare(sanitizeFilename(b.name)) ||
  a.id.localeCompare(b.id);

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
 * sanitized and same-named siblings receive a deterministic suffix. The
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
  const orderedNodes = [...nodes].sort(compareArchiveNode);

  const nodeById = new Map<string, ArchiveNode>();
  for (const node of orderedNodes) {
    nodeById.set(node.id, node);
  }

  const paths = new Map<string, string>();
  const seenSegmentsByParentId = new Map<string, Set<string>>();
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
    const seenSegments = seenSegmentsByParentId.get(node.parentId) ?? new Set();
    seenSegmentsByParentId.set(node.parentId, seenSegments);
    const segment = uniqueSegment(seenSegments, sanitizeFilename(node.name));
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

/**
 * Run `worker` over `items` with at most `concurrency` calls in flight,
 * yielding results in input order. A new worker starts only when the
 * consumer pulls a result, so look-ahead — and memory — stay bounded by
 * `concurrency` even when the consumer is slower than the workers.
 *
 * `worker` must not reject: a rejection surfaces from the generator and
 * breaks the consuming stream. Callers wrap failures into the result.
 *
 * @yields each worker result, in the order of `items`.
 */
export const mapOrderedConcurrent = async function* <T, R>(
  items: Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  const limit = Math.max(1, concurrency);
  const iterator = items[Symbol.iterator]();
  const inFlight: Promise<R>[] = [];

  const startNext = (): boolean => {
    const next = iterator.next();
    if (next.done === true) {
      return false;
    }
    inFlight.push(worker(next.value));
    return true;
  };

  while (inFlight.length < limit) {
    if (!startNext()) {
      break;
    }
  }

  while (inFlight.length > 0) {
    const head = inFlight.shift();
    if (head === undefined) {
      break;
    }
    const result = await head;
    startNext();
    yield result;
  }
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
