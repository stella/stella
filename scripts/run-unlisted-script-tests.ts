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
import { readFileSync } from "node:fs";
import path from "node:path";

type ScriptTestArguments =
  | { readonly type: "valid"; readonly timeout: number | undefined }
  | { readonly type: "invalid"; readonly message: string };

export const parseScriptTestArguments = (
  args: readonly string[],
): ScriptTestArguments => {
  let timeout: number | undefined;
  const argumentsIterator = args.values();
  for (const argument of argumentsIterator) {
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
  return { type: "valid", timeout };
};

type UnlistedTestCommandOptions = {
  readonly files: readonly string[];
  readonly timeout: number | undefined;
};

export const unlistedTestCommands = ({
  files,
  timeout,
}: UnlistedTestCommandOptions): string[][] => {
  const bunTests = files.filter((file) => file.endsWith(".ts"));
  const shellTests = files.filter((file) => file.endsWith(".sh"));
  return [
    ...(bunTests.length === 0
      ? []
      : [
          [
            "bun",
            "test",
            ...(timeout === undefined ? [] : ["--timeout", String(timeout)]),
            ...bunTests,
          ],
        ]),
    ...shellTests.map((file) => ["bash", file]),
  ];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_GLOB = "scripts/**/*.test.{ts,sh}";
const WORKFLOW = ".github/workflows/ci.yml";

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

const scan = (pattern: string): string[] => [
  ...new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT }),
];

const run = (command: readonly string[]): boolean => {
  console.log(`$ ${command.join(" ")}`);
  // Inherited output: a piped stdout is truncated for large test reports.
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    stderr: "inherit",
    stdout: "inherit",
  });
  return result.exitCode === 0;
};

if (import.meta.main) {
  const options = parseScriptTestArguments(process.argv.slice(2));
  if (options.type === "invalid") {
    console.error(
      `Usage: bun scripts/run-unlisted-script-tests.ts [--timeout <positive integer>]\n${options.message}`,
    );
    process.exitCode = 2;
  } else {
    const workflowText = readFileSync(path.join(REPO_ROOT, WORKFLOW), "utf-8");
    const unlisted = unlistedTests(
      scan(TEST_GLOB).filter((file) => !file.includes("/node_modules/")),
      workflowText,
    );
    const commands = unlistedTestCommands({
      files: unlisted,
      timeout: options.timeout,
    });
    const results = commands.map((command) => run(command));
    if (results.includes(false)) {
      panic("Unlisted script tests failed");
    }
    console.log(`Ran ${unlisted.length} unlisted script test file(s).`);
  }
}
