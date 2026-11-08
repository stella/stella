import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

// Uses only built-ins: guards that borrow dependencies run before any install.
class BorrowedDependenciesError extends Error {
  readonly _tag = "BorrowedDependenciesError";

  constructor(message: string) {
    super(message);
    this.name = "BorrowedDependenciesError";
  }
}

const panic = (message: string): never => {
  throw new BorrowedDependenciesError(message);
};

// A workspace package is a relative link (`@stll/x -> ../../packages/x`), so
// it keeps resolving inside the copy; every other entry is shared by its
// absolute path.
const lend = (lent: string, borrowed: string): void => {
  if (lstatSync(lent).isSymbolicLink()) {
    const link = readlinkSync(lent);
    if (!path.isAbsolute(link)) {
      symlinkSync(link, borrowed);
      return;
    }
  }
  symlinkSync(lent, borrowed);
};

// Directory scans read only untracked install trees, never repository
// Markdown.
export const CI_MARKDOWN_READER_INPUTS = ["**/node_modules/**"];

const lendModules = (lentModules: string, borrowedModules: string): void => {
  mkdirSync(borrowedModules, { recursive: true });
  for (const entry of readdirSync(lentModules)) {
    const lent = path.join(lentModules, entry);
    const isScope =
      entry.startsWith("@") &&
      !lstatSync(lent).isSymbolicLink() &&
      lstatSync(lent).isDirectory();
    if (!isScope) {
      lend(lent, path.join(borrowedModules, entry));
      continue;
    }
    mkdirSync(path.join(borrowedModules, entry));
    for (const scoped of readdirSync(lent)) {
      lend(path.join(lent, scoped), path.join(borrowedModules, entry, scoped));
    }
  }
};

/** Workspace directories named by the root manifest's `<directory>/*` globs. */
const workspaceDirectories = (source: string): string[] => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(source, "package.json"), "utf-8"),
  );
  const patterns =
    typeof manifest === "object" &&
    manifest !== null &&
    "workspaces" in manifest
      ? manifest.workspaces
      : undefined;
  if (
    !Array.isArray(patterns) ||
    !patterns.every((pattern): pattern is string => typeof pattern === "string")
  ) {
    return panic("package.json must list its workspaces as strings");
  }
  return patterns.flatMap((pattern) => {
    const parent = /^([\w.-]+(?:\/[\w.-]+)*)\/\*$/u.exec(pattern)?.[1];
    if (parent === undefined) {
      return panic(`Unsupported workspace pattern: ${pattern}`);
    }
    const directory = path.join(source, parent);
    return existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(parent, entry.name))
      : [];
  });
};

/**
 * Lends `source`'s installed dependencies to a disposable copy of the
 * repository at `target`. Workspace packages resolve to the copy's own
 * sources, from the root install and from every workspace's own install
 * alike: a symlink to a lending node_modules directory would resolve them,
 * and every generator or bundler reading them, to the lending checkout.
 */
export const borrowDependencies = (source: string, target: string): void => {
  lendModules(
    path.join(source, "node_modules"),
    path.join(target, "node_modules"),
  );
  for (const workspace of workspaceDirectories(source)) {
    const lent = path.join(source, workspace, "node_modules");
    const borrowed = path.join(target, workspace, "node_modules");
    if (
      existsSync(lent) &&
      existsSync(path.join(target, workspace)) &&
      !existsSync(borrowed)
    ) {
      lendModules(lent, borrowed);
    }
  }
};
