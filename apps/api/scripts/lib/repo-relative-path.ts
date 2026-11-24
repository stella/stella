import path from "node:path";

import { isPathStrictlyInside, repoRelativePath } from "@stll/portable-path";

/**
 * One file-path spelling for the capability codegen on every platform.
 *
 * Bun globs and `path.resolve` return `\`-separated paths on Windows, while
 * capability ids, import specifiers and source-map keys are `/`-separated.
 * Every handler-path containment check and every path-to-id derivation goes
 * through this module, so no caller compares a raw platform path against a
 * `/` prefix.
 */

/** The same path with Windows separators rewritten to `/`. */
export const toPosixPath = (file: string): string =>
  file.split(path.win32.sep).join(path.posix.sep);

/**
 * `file` relative to `root`, `/`-separated, or `undefined` when `file` is not
 * strictly inside `root`. Accepts POSIX and Windows spellings (drive letters,
 * `\` separators) for either argument; both are resolved against the same
 * working directory, so two relative paths compare as relative paths.
 */
export const relativePathWithin = ({
  root,
  file,
}: {
  root: string;
  file: string;
}): string | undefined => {
  const posixRoot = toPosixPath(root);
  const posixFile = toPosixPath(file);
  return isPathStrictlyInside(posixRoot, posixFile, path.posix)
    ? repoRelativePath(posixRoot, posixFile, path.posix)
    : undefined;
};
