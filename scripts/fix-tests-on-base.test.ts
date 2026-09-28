import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkOutBaseSource,
  classifyRun,
  decideVerdict,
  formatReport,
  isTestSide,
  markChangedCases,
  parseJunit,
  parseNameStatus,
  selectTestsToCheck,
  touchedLines,
  type ChangedFile,
  type FileOutcome,
} from "./fix-tests-on-base";

const API_TEST = "apps/api/src/handlers/chat/stream-chat.test.ts";
const API_SOURCE = "apps/api/src/handlers/chat/stream-chat.ts";

const modified = (file: string): ChangedFile => ({
  path: file,
  status: "modified",
});

describe("which pull requests the check runs on", () => {
  test.each([
    "fix: keep ids stable",
    "fix(chat): keep ids stable",
    "fix(api)!: keep ids stable",
  ])("runs a fix titled %p that changes an apps/api test", (title) => {
    expect(
      selectTestsToCheck({
        title,
        body: "",
        changed: [modified(API_SOURCE), modified(API_TEST)],
      }),
    ).toEqual({
      kind: "run",
      testFiles: [API_TEST],
      unchecked: [],
      markerWithoutReason: false,
    });
  });

  test.each([
    "feat(chat): keep ids stable",
    "chore(ci): fix the plan",
    "fixup: keep ids stable",
    "fix keep ids stable",
    "refactor(fix): keep ids stable",
  ])("leaves a pull request titled %p alone", (title) => {
    expect(
      selectTestsToCheck({
        title,
        body: "",
        changed: [modified(API_TEST)],
      }),
    ).toEqual({ kind: "not-a-fix" });
  });

  test("has nothing to run when the fix adds no test a wired runner covers", () => {
    expect(
      selectTestsToCheck({
        title: "fix(ai): end streams",
        body: "",
        changed: [
          modified("packages/ai/src/stream.ts"),
          modified("packages/ai/src/stream.test.ts"),
          { path: "apps/api/src/old.test.ts", status: "deleted" },
          modified("apps/api/src/tests/helpers/chat-oracles.ts"),
        ],
      }),
    ).toEqual({
      kind: "no-tests",
      unchecked: ["packages/ai/src/stream.test.ts"],
    });
  });

  test("lists changed tests of unwired packages beside the ones it runs", () => {
    const selection = selectTestsToCheck({
      title: "fix: end streams",
      body: "",
      changed: [
        { path: API_TEST, status: "added" },
        modified("apps/web/src/features/chat/history.test.ts"),
      ],
    });
    expect(selection).toMatchObject({
      kind: "run",
      testFiles: [API_TEST],
      unchecked: ["apps/web/src/features/chat/history.test.ts"],
    });
  });

  test("skips on a body line that gives a reason, and reports the reason", () => {
    expect(
      selectTestsToCheck({
        title: "fix(chat): keep ids stable",
        body: "Keeps ids stable.\n\ntest-on-base: skip the tests only rename cases\n",
        changed: [modified(API_TEST)],
      }),
    ).toEqual({
      kind: "skip",
      reason: "the tests only rename cases",
      testFiles: [API_TEST],
    });
  });

  test("still runs when the skip line gives no reason", () => {
    expect(
      selectTestsToCheck({
        title: "fix(chat): keep ids stable",
        body: "test-on-base: skip\n",
        changed: [modified(API_TEST)],
      }),
    ).toMatchObject({ kind: "run", markerWithoutReason: true });
  });
});

describe("what stays at the pull request's version on the base tree", () => {
  test.each([
    API_TEST,
    "apps/web/e2e/chat.spec.ts",
    "apps/api/src/tests/helpers/chat-oracles.ts",
    "apps/api/src/handlers/case-law/ingestion/adapters/__fixtures__/nsoud/decision.html",
    "apps/web/src/components/chat/__fixtures__/recorded-conversations/drop.gen.json",
    "packages/ui/src/kanban/fixtures/board.ts",
    "apps/api/src/handlers/case-law/ingestion/adapters/test-utils.ts",
    "apps/web/src/features/chat/test-helpers.ts",
    ".oxlint-plugins/__fixtures__/no-ambient-nondeterminism.fixture.ts",
  ])("keeps %p", (file) => {
    expect(isTestSide(file)).toBe(true);
  });

  test.each([
    API_SOURCE,
    "apps/api/scripts/chat-mutation-matrix.json",
    "apps/api/src/lib/test-timeouts-policy.ts",
    "packages/ai/src/tests.ts",
    "apps/api/src/lib/fixture-loader.ts",
    "packages/cli/src/testing.ts",
  ])("puts %p back to base", (file) => {
    expect(isTestSide(file)).toBe(false);
  });
});

describe("which test cases a diff changes", () => {
  test("reads the head-side lines of every hunk, including pure deletions", () => {
    const diff = [
      "diff --git a/x.test.ts b/x.test.ts",
      "@@ -3 +3 @@ describe(",
      "@@ -10,0 +11,2 @@ test(",
      "@@ -20,4 +22,0 @@",
    ].join("\n");
    expect([...touchedLines(diff)].toSorted((a, b) => a - b)).toEqual([
      3, 11, 12, 22, 23,
    ]);
  });

  const report = parseJunit(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="1">
  <testsuite name="a.test.ts" file="a.test.ts" tests="4">
    <testsuite name="grp &amp; co" file="a.test.ts" line="2" tests="2">
      <testcase name="ok one" classname="grp &amp; co" file="a.test.ts" line="3" assertions="1" />
      <testcase name="bad &quot;two&quot;" classname="grp &amp; co" file="a.test.ts" line="6" assertions="1">
        <failure type="AssertionError" message="Expected: 2&#10;Received: 1">AssertionError</failure>
      </testcase>
    </testsuite>
    <testcase name="later" classname="" file="a.test.ts" line="10" assertions="1">
      <skipped />
    </testcase>
    <testcase name="last" classname="" file="a.test.ts" line="14" assertions="1" />
  </testsuite>
</testsuites>`);

  test("parses bun's JUnit report into named, located results", () => {
    expect(report.cases).toEqual([
      { name: "grp & co > ok one", line: 3, status: "pass" },
      { name: 'grp & co > bad "two"', line: 6, status: "fail" },
      { name: "later", line: 10, status: "skip" },
      { name: "last", line: 14, status: "pass" },
    ]);
    expect(report.declarationLines.toSorted((a, b) => a - b)).toEqual([
      2, 3, 6, 10, 14,
    ]);
  });

  test("marks a case whose body, up to the next declaration, the diff touches", () => {
    const changed = markChangedCases({
      report,
      touched: new Set([8, 20]),
      newFile: false,
    });
    expect(
      changed.filter((testCase) => testCase.changed).map(({ line }) => line),
    ).toEqual([6, 14]);
  });

  test("marks every case of a new file, or of a diff that touches no test body", () => {
    for (const options of [
      { touched: new Set<number>(), newFile: true },
      { touched: new Set([1]), newFile: false },
    ]) {
      expect(
        markChangedCases({ report, ...options }).every(
          ({ changed }) => changed,
        ),
      ).toBe(true);
    }
  });
});

describe("the verdict", () => {
  const junit = (cases: string) =>
    `<testsuites><testsuite name="f" file="f" line="1">${cases}</testsuite></testsuites>`;
  const passing = (line: number) =>
    `<testcase name="t${line}" classname="" line="${line}" />`;
  const failing = (line: number) =>
    `<testcase name="t${line}" classname="" line="${line}"><failure message="x">x</failure></testcase>`;

  test("a file that cannot load on base counts as failing, with the reason", () => {
    const outcome = classifyRun({
      file: API_TEST,
      run: {
        exitCode: 1,
        junitXml: null,
        output:
          "# Unhandled error between tests\nerror: Cannot find module './step-answers' from 'x.test.ts'\n",
      },
      touched: new Set(),
      newFile: true,
    });
    expect(outcome).toEqual({
      kind: "did-not-load",
      file: API_TEST,
      detail: "error: Cannot find module './step-answers' from 'x.test.ts'",
    });
    expect(decideVerdict([outcome]).pass).toBe(true);
  });

  test("passes when a changed case fails on base", () => {
    const outcome = classifyRun({
      file: API_TEST,
      run: {
        exitCode: 1,
        junitXml: junit(passing(3) + failing(9)),
        output: "",
      },
      touched: new Set([10]),
      newFile: false,
    });
    expect(decideVerdict([outcome])).toEqual({
      pass: true,
      failingOnBase: [{ file: API_TEST, name: "t9" }],
      passingOnBase: [],
      inconclusive: [],
    });
  });

  test("fails when only unchanged cases fail on base", () => {
    const outcome = classifyRun({
      file: API_TEST,
      run: {
        exitCode: 1,
        junitXml: junit(failing(3) + passing(9)),
        output: "",
      },
      touched: new Set([10]),
      newFile: false,
    });
    const verdict = decideVerdict([outcome]);
    expect(verdict).toEqual({
      pass: false,
      failingOnBase: [],
      passingOnBase: [{ file: API_TEST, name: "t9" }],
      inconclusive: [],
    });
    const report = formatReport({
      outcomes: [outcome],
      verdict,
      unchecked: [],
      markerWithoutReason: false,
    });
    expect(report.join("\n")).toContain(
      "::error::fix-tests-on-base: no changed test fails on the base source",
    );
    expect(report.join("\n")).toContain("PASSES on base  t9 (line 9)");
  });

  test("fails when every changed case passes on base", () => {
    const outcome = classifyRun({
      file: API_TEST,
      run: { exitCode: 0, junitXml: junit(passing(3)), output: "" },
      touched: new Set(),
      newFile: true,
    });
    expect(decideVerdict([outcome]).pass).toBe(false);
  });

  test("a run that fails only outside every test is not evidence", () => {
    const outcome = classifyRun({
      file: API_TEST,
      run: {
        exitCode: 1,
        junitXml: junit(passing(3)),
        output: "error: afterAll hook failed\n",
      },
      touched: new Set(),
      newFile: true,
    });
    expect(outcome.kind).toBe("errored");
    const verdict = decideVerdict([outcome]);
    expect(verdict).toEqual({
      pass: false,
      failingOnBase: [],
      passingOnBase: [{ file: API_TEST, name: "t3" }],
      inconclusive: [API_TEST],
    });
    expect(
      formatReport({
        outcomes: [outcome],
        verdict,
        unchecked: [],
        markerWithoutReason: false,
      }).join("\n"),
    ).toContain(`inconclusive: ${API_TEST}`);
  });

  test("a skipped changed case is neither evidence nor a failure", () => {
    const outcomes: FileOutcome[] = [
      {
        kind: "ran",
        file: API_TEST,
        cases: [{ name: "t", line: 3, status: "skip", changed: true }],
      },
    ];
    expect(decideVerdict(outcomes)).toEqual({
      pass: false,
      failingOnBase: [],
      passingOnBase: [],
      inconclusive: [],
    });
  });
});

describe("the base tree under the pull request's tests", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  const git = (root: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const write = (root: string, file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const read = (root: string, file: string) =>
    readFileSync(path.join(root, file), "utf-8");

  test("restores changed source to base, keeps test-side files, and undoes it exactly", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fix-tests-on-base-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "ci@example.invalid");
    git(root, "config", "user.name", "ci");
    write(root, "src/fixed.ts", "base\n");
    write(root, "src/retired.ts", "base\n");
    write(root, "src/fixed.test.ts", "base test\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    write(root, "src/fixed.ts", "head\n");
    write(root, "src/added.ts", "head\n");
    rmSync(path.join(root, "src/retired.ts"));
    write(root, "src/fixed.test.ts", "head test\n");
    write(root, "src/__fixtures__/case.json", "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fix: head");
    const head = git(root, "rev-parse", "HEAD");
    const changed = parseNameStatus(
      `${git(
        root,
        "diff",
        "--no-renames",
        "--name-status",
        "-z",
        base,
        head,
      )}\0`,
    );
    expect(changed).toEqual([
      { path: "src/__fixtures__/case.json", status: "added" },
      { path: "src/added.ts", status: "added" },
      { path: "src/fixed.test.ts", status: "modified" },
      { path: "src/fixed.ts", status: "modified" },
      { path: "src/retired.ts", status: "deleted" },
    ]);

    const restore = checkOutBaseSource({ root, base, head, changed });
    expect(read(root, "src/fixed.ts")).toBe("base\n");
    expect(read(root, "src/retired.ts")).toBe("base\n");
    expect(existsSync(path.join(root, "src/added.ts"))).toBe(false);
    expect(read(root, "src/fixed.test.ts")).toBe("head test\n");
    expect(read(root, "src/__fixtures__/case.json")).toBe("{}\n");

    restore();
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(read(root, "src/fixed.ts")).toBe("head\n");
    expect(existsSync(path.join(root, "src/retired.ts"))).toBe(false);
  });
});
