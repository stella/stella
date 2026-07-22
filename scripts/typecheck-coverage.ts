#!/usr/bin/env bun

// Typecheck coverage guard.
//
// A TypeScript file can run through Bun, Vite, Expo, or another loader without
// belonging to any project that CI typechecks. `tsc --listFilesOnly` is the
// compiler's source of truth for project membership, so this guard unions that
// output across every CI typecheck project and rejects repository .ts/.tsx
// files that are absent from the union.
//
// Oxlint fixtures are the sole explicit exemption because many contain
// intentionally invalid source patterns that the rules must detect.
//
// Usage:
//   bun scripts/typecheck-coverage.ts
//   bun scripts/typecheck-coverage.ts --self-test

import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TSC_NATIVE = "packages/scripts/src/tsc-native.ts";
const WORKSPACE_PARENTS = ["apps", "packages"] as const;
const EXEMPT_PREFIXES = [".oxlint-plugins/__fixtures__/"] as const;
const PROJECT_ARGUMENT =
  /(?:^|\s)(?:-p|--project)(?:\s+|=)(["']?)([^\s"';&]+)\1/gu;

type Options = {
  selfTest: boolean;
};

const parseArgs = (args: string[]): Options => {
  let selfTest = false;

  for (const argument of args) {
    if (argument === "--self-test") {
      selfTest = true;
      continue;
    }
    panic(`Unknown argument: ${argument}`);
  }

  return { selfTest };
};

const normalizeRepoPath = (file: string): string =>
  file.split(path.sep).join("/");

const isTypeScriptFile = (file: string): boolean => /\.tsx?$/u.test(file);

const isExempt = (file: string): boolean =>
  EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix));

const run = (command: string[]): string => {
  const result = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `Command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr.toString()}${result.stdout.toString()}`,
    );
  }
  return result.stdout.toString();
};

const lines = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const supplementalProjects = (typecheckCommand: string): string[] => {
  const projects: string[] = [];
  for (const match of typecheckCommand.matchAll(PROJECT_ARGUMENT)) {
    const project = match[2];
    if (project) {
      projects.push(project);
    }
  }
  return projects;
};

const typecheckProjects = (): string[] => {
  const projects = new Set<string>();

  const addProject = (project: string, owner: string): void => {
    const normalized = normalizeRepoPath(project);
    if (!existsSync(path.join(REPO_ROOT, normalized))) {
      panic(`${owner}'s typecheck script references missing ${project}`);
    }
    projects.add(normalized);
  };

  for (const parent of WORKSPACE_PARENTS) {
    const parentPath = path.join(REPO_ROOT, parent);
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const workspace = path.join(parent, entry.name);
      const packagePath = path.join(REPO_ROOT, workspace, "package.json");
      if (!existsSync(packagePath)) {
        continue;
      }

      const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
      const typecheck = packageJson.scripts?.typecheck;
      if (typeof typecheck !== "string") {
        continue;
      }

      addProject(path.join(workspace, "tsconfig.json"), workspace);

      for (const project of supplementalProjects(typecheck)) {
        addProject(path.join(workspace, project), workspace);
      }
    }
  }

  const rootPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
  );
  const repositoryTypecheck = rootPackage.scripts?.["typecheck:repo"];
  if (typeof repositoryTypecheck !== "string") {
    panic("root package.json must define the typecheck:repo script");
  }
  for (const project of supplementalProjects(repositoryTypecheck)) {
    addProject(project, "typecheck:repo");
  }

  return [...projects].sort();
};

const coveredFiles = (projects: string[]): Set<string> => {
  const covered = new Set<string>();

  for (const project of projects) {
    const output = run([
      process.execPath,
      TSC_NATIVE,
      "-p",
      project,
      "--listFilesOnly",
    ]);
    for (const file of lines(output)) {
      const relative = path.relative(REPO_ROOT, path.resolve(file));
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        continue;
      }
      covered.add(normalizeRepoPath(relative));
    }
  }

  return covered;
};

const repositoryTypeScriptFiles = (): Set<string> =>
  new Set(
    lines(
      run([
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.ts",
        "*.tsx",
      ]),
    ).filter(isTypeScriptFile),
  );

const findUncovered = (
  repositoryFiles: Set<string>,
  covered: Set<string>,
): string[] =>
  [...repositoryFiles]
    .filter((file) => !isExempt(file))
    .filter((file) => !covered.has(file))
    .sort();

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    panic(message);
  }
};

const selfTest = (): void => {
  assert(isTypeScriptFile("src/new-file.ts"), "must recognize .ts files");
  assert(isTypeScriptFile("src/env.d.ts"), "must recognize declaration files");
  assert(isTypeScriptFile("src/view.tsx"), "must recognize .tsx files");
  assert(!isTypeScriptFile("src/view.js"), "must ignore non-TypeScript files");

  const parsed = supplementalProjects(
    "tsc --noEmit -p tsconfig.test.json && tsc --project=e2e/tsconfig.json",
  );
  assert(
    parsed.join(",") === "tsconfig.test.json,e2e/tsconfig.json",
    "must discover supplemental typecheck projects",
  );

  const repository = new Set([
    "src/covered.ts",
    "src/missing.tsx",
    ".oxlint-plugins/__fixtures__/intentionally-invalid.ts",
  ]);
  const covered = new Set(["src/covered.ts"]);
  const uncovered = findUncovered(repository, covered);
  assert(
    uncovered.length === 1 && uncovered[0] === "src/missing.tsx",
    "must reject an uncovered repository source while exempting oxlint fixtures",
  );

  console.log("typecheck-coverage --self-test: PASS");
};

const main = (): void => {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    selfTest();
    return;
  }

  const projects = typecheckProjects();
  const repositoryFiles = repositoryTypeScriptFiles();
  const covered = coveredFiles(projects);
  const uncovered = findUncovered(repositoryFiles, covered);

  if (uncovered.length > 0) {
    console.error(
      "typecheck-coverage: TypeScript files belong to no CI typecheck project:\n",
    );
    for (const file of uncovered) {
      console.error(`  - ${file}`);
    }
    console.error(
      "\nAdd each file to the appropriate tsconfig include (and ensure that " +
        "project is run by a CI typecheck script).",
    );
    process.exit(1);
  }

  const candidates = [...repositoryFiles].filter((file) => !isExempt(file));
  console.log(
    `typecheck-coverage: OK. ${candidates.length} TypeScript file(s) covered ` +
      `by ${projects.length} typecheck project(s).`,
  );
};

main();
