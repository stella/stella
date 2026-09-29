/**
 * Path reservation for uploaded skill resources.
 *
 * Pure and synchronous so a multi-file drop can reserve every path up front
 * against one shared set: each reservation mutates `takenPaths`, so two
 * identically named files in the same drop land on distinct paths
 * (`knowledge/foo.md`, `knowledge/foo-2.md`) instead of both deriving the same
 * path from a set that has not seen the first upload yet.
 */

/** Sanitized skill-resource filenames: lowercase alphanumeric plus dot,
 *  underscore, and hyphen, never leading with a separator. */
export const FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

const BINARY_EXTENSION_RE = /\.(?:docx|pdf)$/iu;

export type ReservePathResult =
  | { type: "ok"; path: string }
  | { type: "invalid" };

/**
 * Reserve a collision-free `knowledge/<name>` path for one uploaded file,
 * mutating `takenPaths` so the next reservation from the same set skips it.
 *
 * Binary uploads store extracted text rather than the original bytes, so their
 * stored name swaps the original extension for `.md`.
 */
export const reserveKnowledgePath = (
  fileName: string,
  isBinary: boolean,
  takenPaths: Set<string>,
): ReservePathResult => {
  const baseName = isBinary
    ? `${fileName.replace(BINARY_EXTENSION_RE, "")}.md`
    : fileName;
  const sanitizedName = baseName
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]/gu, "-");
  if (!FILENAME_PATTERN.test(sanitizedName)) {
    return { type: "invalid" };
  }
  const extMatch = /(?<ext>\.[^.]+)?$/u.exec(sanitizedName);
  const ext = extMatch?.groups?.["ext"] ?? "";
  const stem = ext ? sanitizedName.slice(0, -ext.length) : sanitizedName;
  let path = `knowledge/${sanitizedName}`;
  let suffix = 1;
  while (takenPaths.has(path)) {
    suffix += 1;
    path = `knowledge/${stem}-${suffix}${ext}`;
  }
  takenPaths.add(path);
  return { type: "ok", path };
};
