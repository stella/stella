#!/usr/bin/env bun

import { panic } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SECONDARY_PROJECTS = [
  "apps/api/tsconfig.scripts.json",
  "apps/api/tsconfig.contracts.json",
  "apps/legal-atlas-runner/tsconfig.json",
  "tsconfig.scripts.json",
] as const;

const apiSourceRoot = path.join(REPO_ROOT, "apps/api/src");
const generatedApiDeclarations = path.join(
  REPO_ROOT,
  "apps/api/.cache/typecheck-declarations/apps/api/src",
);

export const apiSourceBoundaryViolations = (
  files: readonly string[],
  sourceRoot: string,
) =>
  files.filter((file) => {
    if (/\.d\.[cm]?ts$/u.test(file)) {
      return false;
    }
    const relative = path.relative(sourceRoot, path.resolve(file));
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  });

// Use the same resolver as the typecheck task. Listing the graph skips semantic
// checking and also catches transitive source imports and reference redirects.
export const secondaryProgramFiles = (project: string) => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "check",
      "--listFilesOnly",
      "--threads=1",
      "--project",
      project,
    ],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (childExitStatus(child) !== 0) {
    panic(
      `Cannot list TypeScript program ${project}:\n${child.stdout.toString()}${child.stderr.toString()}`,
    );
  }
  const files = child.stdout
    .toString()
    .split(/\r?\n/u)
    .filter((line) => path.isAbsolute(line));
  if (files.length === 0) {
    panic(`No source files listed for ${project}`);
  }
  return files;
};

export const checkApiSecondaryProgramBoundary = () => {
  if (!existsSync(generatedApiDeclarations)) {
    panic(
      `Generated API declarations are missing: ${path.relative(REPO_ROOT, generatedApiDeclarations)}`,
    );
  }
  const violations: string[] = [];
  for (const project of SECONDARY_PROJECTS) {
    violations.push(
      ...apiSourceBoundaryViolations(
        secondaryProgramFiles(project),
        apiSourceRoot,
      ).map((file) => `${project}: ${path.relative(REPO_ROOT, file)}`),
    );
  }
  return violations;
};

if (import.meta.main) {
  const violations = checkApiSecondaryProgramBoundary();
  if (violations.length > 0) {
    panic(
      `Secondary TypeScript programs must not include apps/api/src implementation files:\n${violations.join("\n")}`,
    );
  }
  console.log(
    `API secondary program boundary: ok (${SECONDARY_PROJECTS.length} projects)`,
  );
}
