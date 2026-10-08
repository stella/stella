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

import { panic, Result, TaggedError } from "better-result";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

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

const listedSuiteSchema = v.object({
  file: v.optional(v.string()),
  suites: v.optional(
    v.array(v.lazy((): v.GenericSchema<ListedSuite> => listedSuiteSchema)),
  ),
});

// Keep consumed fields; the reporter's other metadata is deliberately stripped.
const listingSchema = v.object({
  config: v.object({
    rootDir: v.string(),
    projects: v.array(v.object({ name: v.string(), testDir: v.string() })),
  }),
  suites: v.array(listedSuiteSchema),
  errors: v.array(v.object({ message: v.optional(v.string()) })),
});

export type PlaywrightListing = v.InferOutput<typeof listingSchema>;

class PlaywrightReportError extends TaggedError("PlaywrightReportError")<{
  message: string;
  reason: "missing-report" | "invalid-json" | "invalid-shape";
  cause?: unknown;
}> {}

export const parseListingReport = (stdout: string | null | undefined) => {
  if (!stdout?.trim()) {
    return Result.err(
      new PlaywrightReportError({
        message: "playwright --list printed no report",
        reason: "missing-report",
      }),
    );
  }
  const jsonStart = stdout.indexOf("{");
  const parsed = Result.try({
    try: (): unknown =>
      JSON.parse(jsonStart === -1 ? stdout : stdout.slice(jsonStart)),
    catch: (cause) =>
      new PlaywrightReportError({
        message: "playwright --list printed invalid JSON",
        reason: "invalid-json",
        cause,
      }),
  });
  if (parsed.isErr()) {
    return parsed;
  }
  const validated = v.safeParse(listingSchema, parsed.value);
  if (!validated.success) {
    return Result.err(
      new PlaywrightReportError({
        message: "playwright --list printed an unexpected report shape",
        reason: "invalid-shape",
      }),
    );
  }
  return Result.ok(validated.output);
};

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

class PlaywrightPackageError extends TaggedError("PlaywrightPackageError")<{
  message: string;
  reason: "repository-root" | "missing-package" | "outside-repository";
}> {}

type OwningPackageOptions = { file: string; repositoryRoot?: string };

/** The nearest workspace package above the config, within this repository. */
export const owningPackage = ({
  file,
  repositoryRoot = REPO_ROOT,
}: OwningPackageOptions) => {
  const root = path.resolve(repositoryRoot);
  let directory = path.dirname(path.resolve(file));
  if (!isInside(root, directory)) {
    return Result.err(
      new PlaywrightPackageError({
        message: `${file} is outside the repository`,
        reason: "outside-repository",
      }),
    );
  }
  while (directory !== root) {
    if (existsSync(path.join(directory, "package.json"))) {
      return Result.ok(directory);
    }
    const parent = path.dirname(directory);
    directory = parent;
  }
  if (existsSync(path.join(root, "package.json"))) {
    return Result.err(
      new PlaywrightPackageError({
        message: `${file} is owned by the repository root; give it a workspace package`,
        reason: "repository-root",
      }),
    );
  }
  return Result.err(
    new PlaywrightPackageError({
      message: `${file} has no owning package.json within the repository`,
      reason: "missing-package",
    }),
  );
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
  const owner = owningPackage({ file: absolute });
  if (owner.isErr()) {
    return [`${config}: ${owner.error.message}`];
  }
  const packageRoot = owner.value;
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
  const report = parseListingReport(result.stdout);
  if (report.isErr()) {
    return [
      `${config}: ${report.error.message} (exit ${String(result.status)}): ${result.stderr.trim().split("\n").slice(0, 5).join(" | ")}`,
    ];
  }
  const problems = checkListing(config, packageRoot, report.value);
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
