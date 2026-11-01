import { readFile, symlink } from "node:fs/promises";
import nodePath from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const API_SOURCE = nodePath.resolve(import.meta.dir, "../..");
const ENTRYPOINT = nodePath.join(API_SOURCE, "db/migrate.ts");
const RELATIVE_IMPORT = /from "(\.{1,2}\/[^"]+)"/gu;

/**
 * Links every module the migrate entrypoint imports into a fixture's `src`,
 * beside a copy of the entrypoint at `src/db/migrate.ts`. The list is read
 * from the entrypoint's own imports, so a new import cannot leave a fixture
 * behind: `db` modules link one by one, any other directory links whole.
 */
export const linkMigrateEntrypointImports = async (
  fixtureSource: string,
): Promise<void> => {
  const source = await readFile(ENTRYPOINT, "utf-8");
  const entries = new Set(
    [...source.matchAll(RELATIVE_IMPORT)].map(([, specifier = ""]) => {
      const target = repoRelativePath(
        API_SOURCE,
        nodePath.resolve(nodePath.dirname(ENTRYPOINT), specifier),
      );
      const [head = "", ...rest] = target.split("/");
      return rest.length > 0 && head !== "db" ? head : `${target}.ts`;
    }),
  );
  await Promise.all(
    [...entries].map(async (entry) => {
      await symlink(
        nodePath.join(API_SOURCE, entry),
        nodePath.join(fixtureSource, entry),
      );
    }),
  );
};
