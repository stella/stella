#!/usr/bin/env bun

// Guard: every Playwright config loads, and collects test files only from the
// workspace package that owns it.
//
// A config whose project reaches into another package (`testDir:
// "../../api/e2e"`) runs that package's specs under its own package's module
// settings. A spec that loads as an ES module in one package can fail to load
// in the other, and Playwright then refuses to run any test of the config, so
// one cross-package project broke every shard of the web e2e suite.
//
// The guard enumerates every tracked Playwright config, runs `playwright test
// --list` for it from its package and fails when listing fails (a spec that
// does not load), lists no tests, or resolves a project testDir or a spec file
// outside the package. A package that needs browser checks gets its own
// config.
//
//   bun scripts/check-playwright-config-scope.ts

import { panic } from "better-result";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PLAYWRIGHT_BIN = path.join(REPO_ROOT, "node_modules/.bin/playwright");
const CONFIG_NAME = /^playwright(\.[\w-]+)?\.config\.(ts|mts|js|mjs|cjs)$/u;
// The JSON reporter writes to stdout unless these redirect it to a file.
const REPORT_FILE_ENV = [
  "PLAYWRIGHT_JSON_OUTPUT_FILE",
  "PLAYWRIGHT_JSON_OUTPUT_NAME",
  "PLAYWRIGHT_JSON_OUTPUT_DIR",
] as const;

type ListedSuite = { file?: string; suites?: ListedSuite[] };

export type PlaywrightListing = {
  config: {
    rootDir: string;
    projects: { name: string; testDir: string }[];
  };
  suites: ListedSuite[];
  errors: { message?: string }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isListing = (value: unknown): value is PlaywrightListing =>
  isRecord(value) &&
  isRecord(value["config"]) &&
  typeof value["config"]["rootDir"] === "string" &&
  Array.isArray(value["config"]["projects"]) &&
  Array.isArray(value["suites"]) &&
  Array.isArray(value["errors"]);

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

const listedFiles = (rootDir: string, suites: ListedSuite[]): string[] =>
  suites.flatMap((suite) => [
    ...(suite.file === undefined ? [] : [path.resolve(rootDir, suite.file)]),
    ...listedFiles(rootDir, suite.suites ?? []),
  ]);

/** Problems with one config's `--list` output, given its owning package. */
export const checkListing = (
  config: string,
  packageRoot: string,
  listing: PlaywrightListing,
): string[] => {
  const problems = listing.errors.map(
    (error) =>
      `${config}: failed to load: ${(error.message ?? "unknown error").split("\n", 1).join("")}`,
  );
  for (const project of listing.config.projects) {
    if (!isInside(packageRoot, project.testDir)) {
      problems.push(
        `${config}: project "${project.name}" testDir ${path.relative(REPO_ROOT, project.testDir)} is outside ${path.relative(REPO_ROOT, packageRoot)}`,
      );
    }
  }
  const files = [
    ...new Set(listedFiles(listing.config.rootDir, listing.suites)),
  ];
  for (const file of files) {
    if (!isInside(packageRoot, file)) {
      problems.push(
        `${config}: collects ${path.relative(REPO_ROOT, file)}, outside ${path.relative(REPO_ROOT, packageRoot)}`,
      );
    }
  }
  if (problems.length === 0 && files.length === 0) {
    problems.push(`${config}: lists no tests`);
  }
  return problems;
};

/** The nearest directory above `file` holding a package.json. */
export const owningPackage = (file: string): string => {
  let directory = path.dirname(file);
  while (!existsSync(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      panic(`${file} has no owning package.json`);
    }
    directory = parent;
  }
  return directory;
};

const trackedConfigs = (): string[] => {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    panic(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout
    .split("\0")
    .filter((file) => CONFIG_NAME.test(path.basename(file)))
    .toSorted();
};

const listConfig = (config: string): string[] => {
  const absolute = path.join(REPO_ROOT, config);
  const packageRoot = owningPackage(absolute);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !REPORT_FILE_ENV.some((name) => name === key),
    ),
  );
  const result = spawnSync(
    PLAYWRIGHT_BIN,
    ["test", "--config", absolute, "--list", "--reporter=json"],
    { cwd: packageRoot, encoding: "utf-8", env, maxBuffer: 64 * 1024 * 1024 },
  );
  const jsonStart = result.stdout.indexOf("{");
  if (jsonStart === -1) {
    return [
      `${config}: playwright --list printed no report (exit ${String(result.status)}): ${result.stderr.trim().split("\n").slice(0, 5).join(" | ")}`,
    ];
  }
  const listing: unknown = JSON.parse(result.stdout.slice(jsonStart));
  if (!isListing(listing)) {
    return [`${config}: playwright --list printed an unexpected report shape`];
  }
  const problems = checkListing(config, packageRoot, listing);
  if (problems.length === 0 && result.status !== 0) {
    problems.push(
      `${config}: playwright --list exited ${String(result.status)}`,
    );
  }
  return problems;
};

const main = (): number => {
  const configs = trackedConfigs();
  const problems = configs.flatMap(listConfig);
  if (problems.length > 0) {
    console.error("Playwright configs must load and stay in their package:\n");
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    console.error(
      "\nGive the other package its own Playwright config instead of pointing a project at it.",
    );
    return 1;
  }
  console.log(
    `Playwright config scope OK: ${configs.length} configs list only their own package's specs.`,
  );
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
