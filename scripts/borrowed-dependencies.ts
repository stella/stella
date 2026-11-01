import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

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

/**
 * Lends `source`'s installed dependencies to a disposable copy of the
 * repository at `target`. Workspace packages resolve to the copy's own
 * sources: one symlink to `source/node_modules` would resolve them, and every
 * generator or bundler reading them, to the lending checkout instead.
 */
export const borrowDependencies = (source: string, target: string): void => {
  const modules = path.join(source, "node_modules");
  const borrowed = path.join(target, "node_modules");
  mkdirSync(borrowed, { recursive: true });
  for (const entry of readdirSync(modules)) {
    const lent = path.join(modules, entry);
    const isScope =
      entry.startsWith("@") &&
      !lstatSync(lent).isSymbolicLink() &&
      lstatSync(lent).isDirectory();
    if (!isScope) {
      lend(lent, path.join(borrowed, entry));
      continue;
    }
    mkdirSync(path.join(borrowed, entry));
    for (const scoped of readdirSync(lent)) {
      lend(path.join(lent, scoped), path.join(borrowed, entry, scoped));
    }
  }
  // Workspaces whose dependency versions differ from the root's install them
  // beside their own sources.
  for (const workspace of new Bun.Glob(
    "{apps,packages}/*/node_modules",
  ).scanSync({ cwd: source, onlyFiles: false })) {
    const destination = path.join(target, workspace);
    if (existsSync(path.dirname(destination)) && !existsSync(destination)) {
      symlinkSync(path.join(source, workspace), destination);
    }
  }
};
