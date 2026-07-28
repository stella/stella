#!/usr/bin/env bun

import { panic } from "better-result";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { syncLockfileWorkspaceVersions } from "./lockfile-workspace-versions";

const ROOT = path.resolve(import.meta.dir, "..");

const readJson = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(filePath).text());

const rootPackage = await readJson(path.join(ROOT, "package.json"));
const workspaceGlobs = Array.isArray(rootPackage["workspaces"])
  ? rootPackage["workspaces"].filter(
      (workspace): workspace is string => typeof workspace === "string",
    )
  : panic("root package.json is missing a `workspaces` array");

const workspaceParent = (workspaceGlob: string): string => {
  if (!workspaceGlob.endsWith("/*")) {
    panic(`unsupported workspaces glob ${workspaceGlob}: expected <dir>/*`);
  }
  return workspaceGlob.slice(0, -2);
};

const workspaceDirectories = (
  await Promise.all(
    workspaceGlobs.map(async (workspaceGlob) => {
      const parent = workspaceParent(workspaceGlob);
      const entries = await readdir(path.join(ROOT, parent), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`);
    }),
  )
)
  .flat()
  .sort();

const workspaceVersions = Object.fromEntries(
  (
    await Promise.all(
      workspaceDirectories.map(async (workspace) => {
        const packageJson = await readJson(
          path.join(ROOT, workspace, "package.json"),
        ).catch(() => null);
        if (
          packageJson === null ||
          typeof packageJson["version"] !== "string"
        ) {
          return null;
        }
        return [workspace, packageJson["version"]] as const;
      }),
    )
  ).filter((entry): entry is readonly [string, string] => entry !== null),
);

const lockPath = path.join(ROOT, "bun.lock");
const before = await Bun.file(lockPath).text();
const after = syncLockfileWorkspaceVersions(before, workspaceVersions);
await Bun.write(lockPath, after);
console.log(
  `Synchronized ${Object.keys(workspaceVersions).length} workspace versions.`,
);
