#!/usr/bin/env bun

// The root config only scopes Oxc discovery (files: []); it has no references.
// Compare the explicit projects used by every Bun typecheck task instead.
import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const root = path.resolve(import.meta.dirname, "..");
const projects = new Set<string>();
const collect = (directory: string, command: string): void => {
  for (const match of command.matchAll(
    /\bbun check\b[^;&]*?--project=([^\s;&]+)/gu,
  )) {
    const project = match[1];
    if (project) {
      projects.add(path.relative(root, path.resolve(directory, project)));
    }
  }
};

const manifest = (directory: string): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(path.join(directory, "package.json"), "utf-8"));
collect(root, manifest(root).scripts?.["typecheck:repo"] ?? "");
for (const parent of ["apps", "packages"]) {
  for (const entry of readdirSync(path.join(root, parent), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(root, parent, entry.name);
    collect(directory, manifest(directory).scripts?.["typecheck"] ?? "");
  }
}
if (projects.size === 0) {
  panic("No Bun typecheck projects were selected");
}
// Match the ordinary task prerequisites before comparing identical inputs.
for (const [cwd, command] of [
  [root, [process.execPath, "scripts/ci-generated-sources.ts", "prepare"]],
  [
    path.join(root, "apps/extension"),
    ["bunx", "--no-install", "wxt", "prepare"],
  ],
] as const) {
  const prepare = Bun.spawn([...command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  await prepare.exited;
  const status = childExitStatus(prepare);
  if (status !== 0) {
    process.exit(status);
  }
}
console.log(`Typecheck parity: ${projects.size} repository projects`);
const child = Bun.spawn(
  [
    "bunx",
    "--no-install",
    "stll-typecheck-parity",
    ...[...projects].toSorted().flatMap((project) => ["--project", project]),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit", env: process.env },
);
await child.exited;
process.exitCode = childExitStatus(child);
