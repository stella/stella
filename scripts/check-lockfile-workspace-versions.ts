#!/usr/bin/env bun
// CI gate and byte-preserving repair for workspace self-versions in bun.lock.
//
// A frozen install validates dependency resolution but does not compare each
// workspace package.json version with bun.lock. A plain install does not repair
// that cached value either, while pack/publish tooling can use it when resolving
// workspace dependency ranges. Keep one owner for check-only and write modes.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { syncWorkspaceVersions } from "./lib/bun-lock-workspace-versions";

const ROOT = join(import.meta.dirname, "..");

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(path).text());

const resolveWorkspaceDirs = async (globs: string[]): Promise<string[]> => {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -"/*".length);
      const entries = await readdir(join(ROOT, parent), {
        withFileTypes: true,
      });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
      }
      continue;
    }
    if (glob.includes("*")) {
      throw new Error(
        `Unsupported workspaces glob '${glob}': only a literal path or a single trailing '/*' is supported`,
      );
    }
    dirs.push(glob);
  }
  return dirs;
};

const args = process.argv.slice(2);
if (
  args.some((argument) => argument !== "--write") ||
  args.filter((argument) => argument === "--write").length > 1
) {
  throw new Error(
    "Usage: bun scripts/check-lockfile-workspace-versions.ts [--write]",
  );
}
const write = args[0] === "--write";

const rootPackage = await readJson(join(ROOT, "package.json"));
if (!Array.isArray(rootPackage.workspaces)) {
  throw new Error("root package.json must declare a `workspaces` array");
}
const workspaceDirs = await resolveWorkspaceDirs(
  rootPackage.workspaces as string[],
);
const expectedVersions = new Map<string, string>();
const packageNames = new Map<string, string>();

for (const workspaceDir of workspaceDirs) {
  const pkg = await readJson(join(ROOT, workspaceDir, "package.json")).catch(
    () => null,
  );
  if (pkg === null) continue;
  const { name, version } = pkg;
  if (typeof name !== "string" || typeof version !== "string") continue;
  expectedVersions.set(workspaceDir, version);
  packageNames.set(workspaceDir, name);
}

const lockPath = join(ROOT, "bun.lock");
const lockText = await Bun.file(lockPath).text();
const result = syncWorkspaceVersions(lockText, expectedVersions);
const unrepairable = result.mismatches.filter(({ actual }) => actual === null);

if (write && unrepairable.length === 0 && result.text !== lockText) {
  await Bun.write(lockPath, result.text);
  console.log(
    `bun.lock workspace-version sync: updated ${result.mismatches.length} workspace(s).`,
  );
  process.exit(0);
}

const mismatches = result.mismatches.map(({ workspace, expected, actual }) =>
  actual === null
    ? `${packageNames.get(workspace)} (${workspace}): no writable bun.lock version entry found`
    : `${packageNames.get(workspace)} (${workspace}): package.json is ${expected}, bun.lock has ${actual}`,
);

if (mismatches.length > 0) {
  console.error(
    [
      "bun.lock workspace-version drift detected:",
      "",
      ...mismatches.map((line) => `  - ${line}`),
      "",
      write
        ? "The lockfile shape is incomplete; workspace entries must exist before they can be synchronized."
        : "A plain `bun install` will not fix cached workspace self-versions. Synchronize them with:",
      "",
      "    bun scripts/check-lockfile-workspace-versions.ts --write",
      "    bun install --frozen-lockfile",
      "",
      "Then commit the refreshed bun.lock.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  write
    ? "bun.lock workspace-version sync: already current. OK."
    : "bun.lock workspace-version check: all workspace versions match. OK.",
);
