import { panic } from "better-result";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { partitionRunnerArguments } from "../apps/api/scripts/test-path-filters";
import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { repoRoot } from "./oxlint-config-scopes";

// Subprocess cases measured a passing maximum of 15.814s under CI contention.
const CUSTOM_LINT_TEST_TIMEOUT_MS = 30_000;
const TEST_DIRECTORY = "./.oxlint-plugins/__tests__";
// Each Bun worker can also own one oxlint subprocess; never scale with CPU count.
const CUSTOM_LINT_WORKERS = 2;
const TEST_FILE_PATTERN = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/u;

export const customLintTestCommand = (args: readonly string[] = []) => {
  if (
    args.some(
      (argument) =>
        argument === "--timeout" || argument.startsWith("--timeout="),
    )
  ) {
    panic("Custom lint test timeouts are owned by the shared runner");
  }
  const { patterns } = partitionRunnerArguments(args);
  const paths = patterns.length > 0 ? args : [...args, TEST_DIRECTORY];
  return [
    process.execPath,
    "test",
    "--timeout",
    String(CUSTOM_LINT_TEST_TIMEOUT_MS),
    ...paths,
  ];
};

export const customLintTestCommands = (
  args: readonly string[],
  testPaths: readonly string[],
) => {
  const { bunArguments, patterns } = partitionRunnerArguments(
    args,
    new Set(["--parallel"]),
  );
  const command = customLintTestCommand([...bunArguments, ...patterns]);
  // Preserve selectors and aggregate-output flags in one Bun invocation. The
  // full-suite --parallel flag is owned here, so children cannot add workers.
  if (args.some((argument) => argument !== "--parallel")) {
    return [command];
  }
  if (testPaths.length === 0) {
    return panic("Custom lint test discovery found no test files");
  }
  const batches: string[][] = Array.from(
    { length: CUSTOM_LINT_WORKERS },
    () => [],
  );
  for (const [index, testPath] of testPaths.toSorted().entries()) {
    const batch =
      batches[index % CUSTOM_LINT_WORKERS] ??
      panic("Missing custom lint worker batch");
    batch.push(testPath);
  }
  return batches
    .filter((batch) => batch.length > 0)
    .map((batch) => customLintTestCommand(batch));
};

export const runCustomLintTestCommands = async (
  commands: readonly (readonly string[])[],
  runCommand: (command: readonly string[], worker: number) => Promise<number>,
) => {
  if (commands.length > CUSTOM_LINT_WORKERS) {
    return panic("Custom lint test commands exceed the worker budget");
  }
  const results = await Promise.allSettled(commands.map(runCommand));
  let status = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      return panic("Custom lint worker failed", result.reason);
    }
    if (result.value !== 0) {
      status = childExitStatus(result.value);
    }
  }
  return status;
};

export const runCustomLintTests = async (
  commands: readonly (readonly string[])[],
  coveragePath?: string,
  // The workers' environment; a caller running deliberately failing fixtures
  // passes one without GITHUB_ACTIONS so they emit no CI annotations.
  env: Record<string, string | undefined> = process.env,
) => {
  const coverageDirectory =
    coveragePath === undefined
      ? undefined
      : mkdtempSync(path.join(tmpdir(), "custom-lint-workers-"));
  try {
    const status = await runCustomLintTestCommands(
      commands,
      async (command, worker) => {
        const result = Bun.spawn([...command], {
          cwd: repoRoot,
          env:
            coverageDirectory === undefined
              ? env
              : {
                  ...env,
                  OXLINT_RULE_COVERAGE_PATH: path.join(
                    coverageDirectory,
                    `${worker}.jsonl`,
                  ),
                },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await result.exited;
        return childExitStatus(result);
      },
    );
    // Merge only after both writers exit: no concurrent append can corrupt a
    // record, and existing caller-owned coverage remains append-only.
    if (coveragePath !== undefined && coverageDirectory !== undefined) {
      for (const worker of commands.keys()) {
        const workerPath = path.join(coverageDirectory, `${worker}.jsonl`);
        if (existsSync(workerPath)) {
          appendFileSync(coveragePath, readFileSync(workerPath));
        }
      }
    }
    return status;
  } finally {
    if (coverageDirectory !== undefined) {
      rmSync(coverageDirectory, { recursive: true, force: true });
    }
  }
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const testPaths = args.some((argument) => argument !== "--parallel")
    ? []
    : [
        ...new Bun.Glob(
          "**/*.{js,jsx,ts,tsx,cjs,cjsx,cts,ctsx,mjs,mjsx,mts,mtsx}",
        ).scanSync({
          cwd: path.join(repoRoot, TEST_DIRECTORY),
          onlyFiles: true,
        }),
      ]
        .filter((file) => TEST_FILE_PATTERN.test(file))
        .map((file) => `${TEST_DIRECTORY}/${file}`);
  process.exitCode = await runCustomLintTests(
    customLintTestCommands(args, testPaths),
    process.env["OXLINT_RULE_COVERAGE_PATH"],
  );
}
