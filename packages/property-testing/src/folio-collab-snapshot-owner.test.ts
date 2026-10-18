import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const ROOT = path.join(import.meta.dir, "../../..");
const OWNER = "apps/api/src/lib/files/folio-collab-snapshot-loader.ts";

const sourceFiles = async (directory: string): Promise<string[]> => {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await sourceFiles(entryPath)));
    } else if (
      !entry.name.includes(".test.") &&
      (path.extname(entryPath) === ".ts" || path.extname(entryPath) === ".tsx")
    ) {
      paths.push(entryPath);
    }
  }
  return paths;
};

test("persisted Folio snapshots can only enter through the load owner", async () => {
  const rawLoadSites: string[] = [];
  for (const sourcePath of await sourceFiles(path.join(ROOT, "apps"))) {
    const source = await Bun.file(sourcePath).text();
    if (source.includes("migrateFolioYjsSnapshot")) {
      rawLoadSites.push(repoRelativePath(ROOT, sourcePath));
    }
  }

  expect(rawLoadSites).toEqual([OWNER]);

  const roomStore = await Bun.file(
    path.join(ROOT, "apps/api/src/lib/folio-collab-rooms.ts"),
  ).text();
  expect(roomStore).toContain("loadPersistedFolioSnapshot({");
});
