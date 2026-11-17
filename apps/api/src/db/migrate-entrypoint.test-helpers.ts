import { panic } from "better-result";
import { copyFile, mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

const API_ROOT = path.resolve(import.meta.dir, "../..");
const SOURCE_ENTRYPOINT = path.join(API_ROOT, "src/db/migrate.ts");

// Copy the CLI so adjacent environment fixtures apply, but derive its imports
// from the real source. Linked dependencies retain their original module roots.
export const stageMigrateEntrypoint = async (directory: string) => {
  const entrypoint = path.join(directory, "src/db/migrate.ts");
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await copyFile(SOURCE_ENTRYPOINT, entrypoint);
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(
    await readFile(entrypoint, "utf-8"),
  );
  for (const { path: dependency } of imports) {
    if (!dependency.startsWith(".")) {
      continue;
    }
    const source = Bun.resolveSync(dependency, path.dirname(SOURCE_ENTRYPOINT));
    if (!isPathInside(API_ROOT, source)) {
      panic("Migration fixture imports must stay inside the API package");
    }
    const staged = path.join(directory, repoRelativePath(API_ROOT, source));
    await mkdir(path.dirname(staged), { recursive: true });
    await symlink(source, staged);
  }
  return entrypoint;
};
