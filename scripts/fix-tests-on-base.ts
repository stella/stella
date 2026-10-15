#!/usr/bin/env bun

// A fix's tests must fail without the fix. A test that passes on the base
// source guards nothing: it would have been green before the bug was fixed,
// and it stays green if the fix is reverted.
//
// For a pull request titled `fix: …` / `fix(scope): …` that adds or edits test
// files, this puts the base source back under the pull request's tests and
// runs those test files: every changed file that is not test-side (a test, a
// fixture, a snapshot, a test helper) is restored to the merge base, and a
// file the pull request adds is removed. At least one changed test case must
// then fail. A test file that cannot even load on base (it imports a module
// the pull request adds) counts as failing, reported separately. A run that
// fails only outside every test (a hook, the runner, a memory limit) is not
// evidence: no changed test reached the fault.
//
// A test case counts as changed when the diff touches the lines from its
// declaration to the next test or describe declaration. When a modified file's
// diff touches no test (a shared helper or setup at module scope), every test
// in it counts.
//
// A legitimate exception (a fix whose tests only tidy existing ones, a change
// no test can observe) states itself in the pull request body with a line
// `test-on-base: skip <reason>`; the check prints the reason and passes.
//
// Test runners are per package. apps/api is wired; a test file in another
// package is listed as unchecked until its runner is added to TEST_RUNNERS.
//
// The check changes the working tree while it runs and restores it afterwards,
// so it needs a clean checkout of the head commit:
//
//   bun scripts/fix-tests-on-base.ts --base origin/main
//   bun scripts/fix-tests-on-base.ts --base HEAD^1 --title "$PR_TITLE" --body-file body.md
//
// To check a commit older than this file, copy the file into that checkout
// and run it there; a squashed commit's message stands in for the title and
// body: `bun scripts/fix-tests-on-base.ts --base <commit>^`.

import { panic } from "better-result";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { repoRelativePath } from "@stll/portable-path";

const CHECK = "fix-tests-on-base";

/** Conventional Commit `fix` type, scoped or not, breaking or not. */
const FIX_TITLE = /^fix(?:\([^)]*\))?!?:\s/u;
/** The escape hatch, one line of the pull request body. */
const SKIP_MARKER = /^[ \t]*test-on-base:[ \t]*skip\b(.*)$/imu;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** Directories that hold only test support: fixtures, snapshots, helpers. */
const TEST_SUPPORT_DIRECTORIES = new Set([
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "fixtures",
  "test-utils",
  "tests",
]);

/**
 * Test-only helper modules named by file rather than directory, as the lint
 * configuration's test carve-outs name them: a `test-utils.ts` beside the
 * code it supports is test-only wherever it sits.
 */
const TEST_SUPPORT_FILE =
  /(?:^|\/|\.)(?:test-utils|test-helpers?|fixtures?)\.[cm]?[jt]sx?$/u;

/**
 * A file that belongs to the tests rather than the code under test, so it
 * keeps the pull request's version on the base tree.
 */
export const isTestSide = (file: string): boolean =>
  TEST_FILE.test(file) ||
  TEST_SUPPORT_FILE.test(file) ||
  file
    .split("/")
    .slice(0, -1)
    .some((segment) => TEST_SUPPORT_DIRECTORIES.has(segment));

export type ChangeStatus = "added" | "modified" | "deleted";

export type ChangedFile = {
  readonly path: string;
  readonly status: ChangeStatus;
};

/** One package's test runner. */
export type TestRunner = {
  /** Package directory, relative to the repository root. */
  readonly root: string;
  /** Whether this runner runs the repository-relative test file. */
  readonly ownsTestFile: (file: string) => boolean;
  /** Runs one test file and returns its JUnit report, if one was written. */
  readonly run: (options: {
    readonly repoRoot: string;
    readonly file: string;
    readonly junitPath: string;
  }) => TestFileRun;
};

export type TestFileRun = {
  readonly exitCode: number;
  readonly junitXml: string | null;
  readonly output: string;
};

const readIfPresent = (file: string): string | null => {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
};

const API_ROOT = "apps/api";
/** apps/api/scripts/run-tests.ts runs test files under these roots only. */
const API_TEST_FILE = /^apps\/api\/(?:src|evals|scripts)\/.+\.test\.tsx?$/u;

const apiRunner: TestRunner = {
  root: API_ROOT,
  ownsTestFile: (file) => API_TEST_FILE.test(file),
  run: ({ repoRoot, file, junitPath }) => {
    // The package script, so the preload, batching and PGlite snapshot the
    // suite depends on are the same as in CI.
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "test",
        repoRelativePath(API_ROOT, file),
        "--reporter=junit",
        `--reporter-outfile=${junitPath}`,
      ],
      {
        cwd: path.join(repoRoot, API_ROOT),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: result.success ? 0 : Math.max(result.exitCode, 1),
      junitXml: readIfPresent(junitPath),
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  },
};

export const TEST_RUNNERS: readonly TestRunner[] = [apiRunner];

export type Selection =
  | { readonly kind: "not-a-fix" }
  | { readonly kind: "no-tests"; readonly unchecked: readonly string[] }
  | {
      readonly kind: "skip";
      readonly reason: string;
      readonly testFiles: readonly string[];
    }
  | {
      readonly kind: "run";
      readonly testFiles: readonly string[];
      readonly unchecked: readonly string[];
      /** A skip marker without a reason, which does not count. */
      readonly markerWithoutReason: boolean;
    };

export const readSkipMarker = (
  body: string,
): { readonly reason: string } | null => {
  const match = SKIP_MARKER.exec(body);
  return match ? { reason: (match[1] ?? "").trim() } : null;
};

export const selectTestsToCheck = ({
  title,
  body,
  changed,
  runners = TEST_RUNNERS,
}: {
  readonly title: string;
  readonly body: string;
  readonly changed: readonly ChangedFile[];
  readonly runners?: readonly TestRunner[];
}): Selection => {
  if (!FIX_TITLE.test(title.trim())) {
    return { kind: "not-a-fix" };
  }
  const changedTests = changed
    .filter(
      ({ path: file, status }) => status !== "deleted" && TEST_FILE.test(file),
    )
    .map(({ path: file }) => file);
  const testFiles = changedTests.filter((file) =>
    runners.some((runner) => runner.ownsTestFile(file)),
  );
  const unchecked = changedTests.filter((file) => !testFiles.includes(file));
  if (testFiles.length === 0) {
    return { kind: "no-tests", unchecked };
  }
  const marker = readSkipMarker(body);
  if (marker !== null && marker.reason !== "") {
    return { kind: "skip", reason: marker.reason, testFiles };
  }
  return {
    kind: "run",
    testFiles,
    unchecked,
    markerWithoutReason: marker !== null,
  };
};

/** Head-side line numbers a `git diff -U0` touches, per hunk. */
export const touchedLines = (unifiedDiff: string): ReadonlySet<number> => {
  const lines = new Set<number>();
  for (const match of unifiedDiff.matchAll(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu,
  )) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) {
      // A pure deletion sits between head lines `start` and `start + 1`.
      lines.add(start);
      lines.add(start + 1);
      continue;
    }
    for (let line = start; line < start + count; line += 1) {
      lines.add(line);
    }
  }
  return lines;
};

export type TestCaseStatus = "pass" | "fail" | "skip";

export type TestCase = {
  readonly name: string;
  readonly line: number;
  readonly status: TestCaseStatus;
};

export type JunitReport = {
  readonly cases: readonly TestCase[];
  /** Every test and describe declaration line, which bound a test's body. */
  readonly declarationLines: readonly number[];
};

const decodeXml = (text: string): string =>
  text.replaceAll(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu,
    (_, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return String.fromCodePoint(
            entity.startsWith("#x")
              ? Number.parseInt(entity.slice(2), 16)
              : Number(entity.slice(1)),
          );
      }
    },
  );

const readAttributes = (tag: string): ReadonlyMap<string, string> =>
  new Map(
    [...tag.matchAll(/\s([\w-]+)="([^"]*)"/gu)].map(
      ([, name = "", value = ""]) => [name, decodeXml(value)],
    ),
  );

/** Bun's JUnit report, reduced to what the verdict needs. */
export const parseJunit = (
  xml: string,
  onFailure?: (file: string | undefined) => void,
): JunitReport => {
  const cases: TestCase[] = [];
  for (const match of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu,
  )) {
    const attributes = readAttributes(match[1] ?? "");
    const inner = match[2] ?? "";
    const describe = attributes.get("classname") ?? "";
    const name = attributes.get("name") ?? "";
    let status: TestCaseStatus = "pass";
    if (/<(?:failure|error)\b/u.test(inner)) {
      status = "fail";
      onFailure?.(attributes.get("file"));
    } else if (/<skipped\b/u.test(inner)) {
      status = "skip";
    }
    cases.push({
      name: describe === "" ? name : `${describe} > ${name}`,
      line: Number(attributes.get("line") ?? "0"),
      status,
    });
  }
  const declarationLines = [
    ...xml.matchAll(/<(?:testcase|testsuite)\b[^>]*?\sline="(\d+)"/gu),
  ].map(([, line]) => Number(line));
  return { cases, declarationLines };
};

export type CheckedCase = TestCase & { readonly changed: boolean };

/**
 * Marks the cases whose body the diff touches. A new file, or a diff that
 * touches no test body, marks every case.
 */
export const markChangedCases = ({
  report,
  touched,
  newFile,
}: {
  readonly report: JunitReport;
  readonly touched: ReadonlySet<number>;
  readonly newFile: boolean;
}): readonly CheckedCase[] => {
  const declarations = [...new Set(report.declarationLines)].toSorted(
    (left, right) => left - right,
  );
  const touches = ({ line }: TestCase): boolean => {
    const end =
      declarations.find((declaration) => declaration > line) ??
      Number.POSITIVE_INFINITY;
    for (const touchedLine of touched) {
      if (touchedLine >= line && touchedLine < end) {
        return true;
      }
    }
    return false;
  };
  const touchesAny = newFile || report.cases.some(touches);
  return report.cases.map((testCase): CheckedCase => ({
    name: testCase.name,
    line: testCase.line,
    status: testCase.status,
    changed: !touchesAny || newFile || touches(testCase),
  }));
};

export type FileOutcome =
  | {
      readonly kind: "did-not-load";
      readonly file: string;
      readonly detail: string;
    }
  | {
      readonly kind: "errored";
      readonly file: string;
      readonly exitCode: number;
      readonly detail: string;
      readonly cases: readonly CheckedCase[];
    }
  | {
      readonly kind: "ran";
      readonly file: string;
      readonly cases: readonly CheckedCase[];
    };

const LOAD_ERROR =
  /Cannot find module|Cannot find package|Export named .+ not found|SyntaxError|does not provide an export named|is not exported/u;

/** The line of runner output that says why a file failed, if one does. */
export const failureDetail = (output: string): string => {
  const lines = output.split("\n").map((line) => line.trim());
  return (
    lines.find((line) => LOAD_ERROR.test(line)) ??
    lines.find((line) => /^error:/iu.test(line)) ??
    "no test reported a result; see the log above"
  );
};

export const classifyRun = ({
  file,
  run,
  touched,
  newFile,
}: {
  readonly file: string;
  readonly run: TestFileRun;
  readonly touched: ReadonlySet<number>;
  readonly newFile: boolean;
}): FileOutcome => {
  const report =
    run.junitXml === null
      ? { cases: [], declarationLines: [] }
      : parseJunit(run.junitXml);
  if (report.cases.length === 0 && run.exitCode !== 0) {
    return { kind: "did-not-load", file, detail: failureDetail(run.output) };
  }
  const cases = markChangedCases({ report, touched, newFile });
  if (run.exitCode !== 0 && !cases.some(({ status }) => status === "fail")) {
    return {
      kind: "errored",
      file,
      exitCode: run.exitCode,
      detail: failureDetail(run.output),
      cases,
    };
  }
  return { kind: "ran", file, cases };
};

export type Verdict = {
  readonly pass: boolean;
  /** Changed cases that fail on base: the evidence the tests guard the fix. */
  readonly failingOnBase: readonly { file: string; name: string }[];
  /** Changed cases that pass on base. */
  readonly passingOnBase: readonly { file: string; name: string }[];
  /** Files whose run failed only outside every test: no evidence either way. */
  readonly inconclusive: readonly string[];
};

export const decideVerdict = (outcomes: readonly FileOutcome[]): Verdict => {
  const failingOnBase: { file: string; name: string }[] = [];
  const passingOnBase: { file: string; name: string }[] = [];
  const inconclusive: string[] = [];
  let didNotLoad = false;
  for (const outcome of outcomes) {
    if (outcome.kind === "did-not-load") {
      didNotLoad = true;
      continue;
    }
    if (outcome.kind === "errored") {
      inconclusive.push(outcome.file);
    }
    for (const { changed, name, status } of outcome.cases) {
      if (!changed || status === "skip") {
        continue;
      }
      (status === "fail" ? failingOnBase : passingOnBase).push({
        file: outcome.file,
        name,
      });
    }
  }
  return {
    pass: didNotLoad || failingOnBase.length > 0,
    failingOnBase,
    passingOnBase,
    inconclusive,
  };
};

const CASE_LABEL: Readonly<Record<TestCaseStatus, string>> = {
  fail: "fails on base ",
  pass: "PASSES on base",
  skip: "skipped       ",
};

const describeOutcome = (outcome: FileOutcome): string[] => {
  if (outcome.kind === "did-not-load") {
    return [
      `  ${outcome.file}: did not load on base (counts as failing; usually a module this pull request adds)`,
      `      ${outcome.detail}`,
    ];
  }
  const changed = outcome.cases.filter((testCase) => testCase.changed);
  const header =
    outcome.kind === "errored"
      ? `  ${outcome.file}: exited ${outcome.exitCode} on base outside any test (not evidence): ${outcome.detail}`
      : `  ${outcome.file}: ${changed.length} of ${outcome.cases.length} tests changed`;
  return [
    header,
    ...changed.map(
      ({ line, name, status }) =>
        `      ${CASE_LABEL[status]}  ${name} (line ${line})`,
    ),
  ];
};

export const formatReport = ({
  outcomes,
  verdict,
  unchecked,
  markerWithoutReason,
}: {
  readonly outcomes: readonly FileOutcome[];
  readonly verdict: Verdict;
  readonly unchecked: readonly string[];
  readonly markerWithoutReason: boolean;
}): string[] => {
  const lines = outcomes.flatMap(describeOutcome);
  if (unchecked.length > 0) {
    lines.push(
      `  not checked (no runner wired for their package yet): ${unchecked.join(", ")}`,
    );
  }
  if (markerWithoutReason) {
    lines.push(
      "  a `test-on-base: skip` line without a reason does not count; add the reason after `skip`.",
    );
  }
  if (verdict.pass) {
    lines.push(`${CHECK}: the changed tests fail without the fix.`);
    return lines;
  }
  lines.push(
    `::error::${CHECK}: no changed test fails on the base source, so these tests would pass without the fix.`,
    "  fix: make a test reach the fixed behaviour, or, when no test can, add a line",
    "  `test-on-base: skip <reason>` to the pull request body and re-run the job.",
  );
  if (verdict.inconclusive.length > 0) {
    lines.push(
      `  failed outside every test on base, so inconclusive: ${verdict.inconclusive.join(", ")}; see the log above.`,
    );
  }
  return lines;
};

type GitResult = { readonly ok: boolean; readonly stdout: string };

const git = (root: string, args: readonly string[]): GitResult => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
};

const gitOutput = (root: string, args: readonly string[]): string => {
  const result = git(root, args);
  return result.ok ? result.stdout : panic(`git ${args.join(" ")} failed`);
};

const STATUS_BY_LETTER: Readonly<Record<string, ChangeStatus>> = {
  A: "added",
  D: "deleted",
  M: "modified",
  T: "modified",
};

export const parseNameStatus = (output: string): ChangedFile[] => {
  const fields = output.split("\0").filter(Boolean);
  const changed: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const letter = fields[index] ?? "";
    changed.push({
      path: fields[index + 1] ?? "",
      status: STATUS_BY_LETTER[letter] ?? panic(`unexpected status ${letter}`),
    });
  }
  return changed;
};

/**
 * Puts the base source under the head's tests; returns the undo. Only the
 * files the pull request changed move, so the tree is the head everywhere else.
 */
export const checkOutBaseSource = ({
  root,
  base,
  head,
  changed,
}: {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly changed: readonly ChangedFile[];
}): (() => void) => {
  const source = changed.filter(({ path: file }) => !isTestSide(file));
  const added = source
    .filter(({ status }) => status === "added")
    .map(({ path: file }) => file);
  const existing = source
    .filter(({ status }) => status !== "added")
    .map(({ path: file }) => file);
  const deleted = source
    .filter(({ status }) => status === "deleted")
    .map(({ path: file }) => file);
  const present = source
    .filter(({ status }) => status !== "deleted")
    .map(({ path: file }) => file);
  const batch = (args: readonly string[], files: readonly string[]) => {
    if (files.length > 0) {
      gitOutput(root, [...args, "--", ...files]);
    }
  };
  batch(["rm", "-q", "-f"], added);
  batch(["checkout", base], existing);
  process.stdout.write(
    `  source put back to base: ${existing.length} restored, ${added.length} removed\n`,
  );
  return () => {
    batch(["rm", "-q", "-f"], deleted);
    batch(["checkout", head], present);
  };
};

export type CheckOptions = {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly title: string | null;
  readonly body: string | null;
};

const USAGE =
  "usage: fix-tests-on-base.ts --base <ref> [--head <ref>] [--title <text>] [--body-file <path>] [--root <path>]";

const parseCheckArgs = (args: readonly string[]): CheckOptions => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      "body-file": { type: "string" },
      head: { type: "string", default: "HEAD" },
      root: { type: "string" },
      title: { type: "string" },
    },
    strict: true,
  });
  const bodyFile = values["body-file"];
  return {
    root: path.resolve(values.root ?? path.join(import.meta.dirname, "..")),
    base: values.base ?? panic(USAGE),
    head: values.head,
    title: values.title ?? null,
    body: bodyFile === undefined ? null : readFileSync(bodyFile, "utf-8"),
  };
};

const writeSummary = (lines: readonly string[]): void => {
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    appendFileSync(
      summary,
      `### ${CHECK}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`,
    );
  }
};

const print = (lines: readonly string[]): void => {
  process.stdout.write(`${lines.join("\n")}\n`);
  writeSummary(lines);
};

const main = (args: readonly string[]): number => {
  const options = parseCheckArgs(args);
  const { root } = options;
  const head = gitOutput(root, [
    "rev-parse",
    `${options.head}^{commit}`,
  ]).trim();
  const base = gitOutput(root, ["merge-base", options.base, head]).trim();
  // A squashed commit's message is its pull request's title and body.
  const title =
    options.title ?? gitOutput(root, ["log", "-1", "--format=%s", head]).trim();
  const body =
    options.body ?? gitOutput(root, ["log", "-1", "--format=%b", head]);
  const changed = parseNameStatus(
    gitOutput(root, [
      "diff",
      "--no-renames",
      "--name-status",
      "-z",
      base,
      head,
    ]),
  );
  const selection = selectTestsToCheck({ title, body, changed });
  switch (selection.kind) {
    case "not-a-fix":
      print([`${CHECK}: not a fix pull request; nothing to check.`]);
      return 0;
    case "no-tests":
      print([
        `${CHECK}: the fix changes no test file a wired runner covers; nothing to check.`,
        ...(selection.unchecked.length > 0
          ? [
              `  not checked (no runner wired yet): ${selection.unchecked.join(", ")}`,
            ]
          : []),
      ]);
      return 0;
    case "skip":
      print([
        `::notice::${CHECK}: skipped by the pull request body: ${selection.reason}`,
        `  not run on base: ${selection.testFiles.join(", ")}`,
      ]);
      return 0;
    case "run":
      break;
    default:
      selection satisfies never;
      return panic(`unhandled selection ${String(selection)}`);
  }

  if (gitOutput(root, ["rev-parse", "HEAD"]).trim() !== head) {
    return panic(`check out ${options.head} first: the check runs in place`);
  }
  if (
    gitOutput(root, ["status", "--porcelain", "--untracked-files=no"]) !== ""
  ) {
    return panic(
      "the working tree has changes; the check needs a clean checkout",
    );
  }

  process.stdout.write(
    `${CHECK}: ${title}\n  base ${base.slice(0, 10)} (merge base), head ${head.slice(0, 10)}\n`,
  );
  const changedByPath = new Map(changed.map((file) => [file.path, file]));
  const outDirectory = mkdtempSync(path.join(tmpdir(), `${CHECK}-`));
  const restore = checkOutBaseSource({ root, base, head, changed });
  const outcomes: FileOutcome[] = [];
  try {
    for (const [index, file] of selection.testFiles.entries()) {
      const runner =
        TEST_RUNNERS.find((candidate) => candidate.ownsTestFile(file)) ??
        panic(`no runner owns ${file}`);
      process.stdout.write(`  running ${file} on base ...\n`);
      const run = runner.run({
        repoRoot: root,
        file,
        junitPath: path.join(outDirectory, `${index}.xml`),
      });
      process.stdout.write(run.output);
      const newFile = changedByPath.get(file)?.status === "added";
      outcomes.push(
        classifyRun({
          file,
          run,
          touched: newFile
            ? new Set()
            : touchedLines(
                gitOutput(root, ["diff", "-U0", base, head, "--", file]),
              ),
          newFile,
        }),
      );
    }
  } finally {
    restore();
    rmSync(outDirectory, { force: true, recursive: true });
  }

  const verdict = decideVerdict(outcomes);
  print(
    formatReport({
      outcomes,
      verdict,
      unchecked: selection.unchecked,
      markerWithoutReason: selection.markerWithoutReason,
    }),
  );
  return verdict.pass ? 0 : 1;
};

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `::error::${CHECK}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}
