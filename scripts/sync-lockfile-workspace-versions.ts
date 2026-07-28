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
  if (
    !workspaceGlob.endsWith("/*") ||
    workspaceGlob.slice(0, -2).includes("*")
  ) {
    panic(
      `unsupported workspaces glob ${workspaceGlob}: expected a literal path or <dir>/*`,
    );
  }
  return workspaceGlob.slice(0, -2);
};

const workspaceDirectories = (
  await Promise.all(
    workspaceGlobs.map(async (workspaceGlob) => {
      if (!workspaceGlob.includes("*")) {
        return [workspaceGlob];
      }
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
        const packagePath = path.join(ROOT, workspace, "package.json");
        const packageFile = Bun.file(packagePath);
        if (!(await packageFile.exists())) {
          return null;
        }
        const packageJson: Record<string, unknown> = JSON.parse(
          await packageFile.text(),
        );
        if (typeof packageJson["version"] !== "string") {
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
const entryCount = Object.keys(workspaceVersions).length;
if (process.argv.includes("--check-entries")) {
  console.log(`Verified ${entryCount} bun.lock workspace entries.`);
} else {
  await Bun.write(lockPath, after);
  console.log(`Synchronized ${entryCount} workspace versions.`);
}
