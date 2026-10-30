#!/usr/bin/env bun

// Runs every test under scripts/ that no CI workflow step names.
//
// Root script tests are not a workspace package, so no `turbo run test` ever
// reaches them; each runs only where a workflow step calls it by path. A test
// added without that step never ran: the Dockerfile entrypoint guard sat
// orphaned while the gap it exists to catch shipped. The steps that do name a
// test stay where they are, since several are placed to run before or without
// the dependency install. This run takes the remainder, so the set of tests CI
// executes is derived from the directory rather than kept by hand.
//
//   bun scripts/run-unlisted-script-tests.ts

import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readCiCheckCommandText } from "./ci-check-pool-registry";

type ScriptTestArguments =
  | {
      readonly type: "valid";
      readonly timeout: number | undefined;
      readonly depth: boolean;
    }
  | { readonly type: "invalid"; readonly message: string };

export const parseScriptTestArguments = (
  args: readonly string[],
): ScriptTestArguments => {
  let timeout: number | undefined;
  let depth = false;
  const argumentsIterator = args.values();
  for (const argument of argumentsIterator) {
    if (argument === "--depth") {
      if (depth) {
        return { type: "invalid", message: "--depth may be supplied once" };
      }
      depth = true;
      continue;
    }
    if (argument !== "--timeout") {
      return { type: "invalid", message: `unknown argument: ${argument}` };
    }
    if (timeout !== undefined) {
      return { type: "invalid", message: "--timeout may be supplied once" };
    }
    const raw = argumentsIterator.next().value;
    if (typeof raw !== "string" || !/^\d+$/u.test(raw)) {
      return {
        type: "invalid",
        message: "--timeout requires a positive integer",
      };
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return {
        type: "invalid",
        message: "--timeout requires a positive integer",
      };
    }
    timeout = parsed;
  }
  return { type: "valid", timeout, depth };
};

type UnlistedTestCommandOptions = {
  readonly files: readonly string[];
  readonly timeout: number | undefined;
  /** Bun processes the test files are spread over; they run at once. */
  readonly groups?: number;
  /** A file's expected cost (its size); the heaviest are placed first. */
  readonly weightOf?: (file: string) => number;
};

/**
 * `files` spread over at most `groups` lists, heaviest first onto the
 * lightest list, so each list costs about the same. Ties break by path, so
 * the split is the same on every run.
 */
export const balanceTestFiles = (
  files: readonly string[],
  groups: number,
  weightOf: (file: string) => number,
): string[][] => {
  const lists = Array.from(
    { length: Math.max(1, Math.min(groups, files.length)) },
    () => ({ files: [] as string[], weight: 0 }),
  );
  const ordered = files
    .map((file) => ({ file, weight: weightOf(file) }))
    .toSorted((a, b) => {
      if (a.weight !== b.weight) {
        return b.weight - a.weight;
      }
      // Repository paths, compared by code unit: the order only has to be
      // stable, not linguistic.
      if (a.file === b.file) {
        return 0;
      }
      return a.file < b.file ? -1 : 1;
    });
  for (const { file, weight } of ordered) {
    let lightest = lists[0] ?? panic("A balance has a group");
    for (const list of lists) {
      if (list.weight < lightest.weight) {
        lightest = list;
      }
    }
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return lists
    .map((list) => list.files.toSorted())
    .filter((list) => list.length > 0);
};

export const unlistedTestCommands = ({
  files,
  timeout,
  groups = 1,
  weightOf = () => 1,
}: UnlistedTestCommandOptions): string[][] => {
  const bunTests = files.filter((file) => file.endsWith(".ts"));
  const shellTests = files.filter((file) => file.endsWith(".sh"));
  return [
    ...balanceTestFiles(bunTests, groups, weightOf).map((group) => [
      "bun",
      "test",
      ...(timeout === undefined ? [] : ["--timeout", String(timeout)]),
      ...group,
    ]),
    ...shellTests.map((file) => ["bash", file]),
  ];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_GLOB = "scripts/**/*.test.{ts,sh}";
const DEPTH_TESTS = Object.keys(
  await Bun.file(new URL("depth-script-tests.json", import.meta.url)).json(),
);

/** Workflow text minus comment lines: a mention in a comment runs nothing. */
const withoutComments = (workflowText: string): string =>
  workflowText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/** Tests whose repository path appears in no workflow command. */
export const unlistedTests = (
  tests: readonly string[],
  workflowText: string,
): string[] => {
  const commands = withoutComments(workflowText);
  return tests.filter((test) => !commands.includes(test)).toSorted();
};

export const selectScriptTests = (
  discovered: readonly string[],
  depthTests: readonly string[],
  depth: boolean,
): string[] => {
  const depthSet = new Set(depthTests);
  return depth
    ? depthTests.filter((file) => discovered.includes(file))
    : discovered.filter((file) => !depthSet.has(file));
};

const scan = (pattern: string): string[] => [
  ...new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT }),
];

/**
 * Runs `command` with its output in files, then prints it whole, so commands
 * running at once never interleave their reports. Files, not pipes: a piped
 * stdout is truncated for large test reports.
 */
const run = async (command: readonly string[]): Promise<boolean> => {
  const directory = mkdtempSync(path.join(tmpdir(), "unlisted-script-tests-"));
  const stdoutPath = path.join(directory, "stdout.log");
  const stderrPath = path.join(directory, "stderr.log");
  try {
    const child = Bun.spawn([...command], {
      cwd: REPO_ROOT,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await child.exited;
    console.log(`$ ${command.join(" ")}`);
    process.stdout.write(readFileSync(stdoutPath, "utf-8"));
    process.stderr.write(readFileSync(stderrPath, "utf-8"));
    return exitCode === 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** Bun test processes at once: two, so this check and the other checks
 *  of the job's pool stay close to the runner's four cores. */
const UNLISTED_TEST_GROUPS = 2;

if (import.meta.main) {
  const options = parseScriptTestArguments(process.argv.slice(2));
  if (options.type === "invalid") {
    console.error(
      `Usage: bun scripts/run-unlisted-script-tests.ts [--depth] [--timeout <positive integer>]\n${options.message}`,
    );
    process.exitCode = 2;
  } else {
    // Pooled checks run their commands from the check pool registries.
    const workflowText = readCiCheckCommandText(REPO_ROOT);
    const discovered = unlistedTests(
      scan(TEST_GLOB).filter((file) => !file.includes("/node_modules/")),
      workflowText,
    );
    const unlisted = selectScriptTests(discovered, DEPTH_TESTS, options.depth);
    const commands = unlistedTestCommands({
      files: unlisted,
      timeout: options.timeout,
      groups: UNLISTED_TEST_GROUPS,
      weightOf: (file) => statSync(path.join(REPO_ROOT, file)).size,
    });
    const results = await Promise.all(
      commands.map(async (command) => await run(command)),
    );
    if (results.includes(false)) {
      panic("Unlisted script tests failed");
    }
    console.log(`Ran ${unlisted.length} unlisted script test file(s).`);
  }
}
