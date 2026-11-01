import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { verdictOf } from "./marketing-screenshot-verdict";

const report = (
  ...specs: {
    title: string;
    status: string;
    messages: string[];
    testStatus?: string;
  }[]
) => ({
  suites: [
    {
      suites: [
        {
          specs: specs.map(({ title, status, messages, testStatus }) => ({
            title,
            tests: [
              {
                ...(testStatus === undefined ? {} : { status: testStatus }),
                results: [
                  { status, errors: messages.map((message) => ({ message })) },
                ],
              },
            ],
          })),
        },
      ],
    },
  ],
  errors: [],
});

const MISMATCH =
  "Error: expect(page).toHaveScreenshot(expected) failed\n\n  127705 pixels (ratio 0.03 of all image pixels) are different.";

test("a screenshot-only failure passes with a warning", () => {
  expect(
    verdictOf(
      report(
        {
          title: "capture landing product screenshots",
          status: "failed",
          messages: [MISMATCH, MISMATCH],
        },
        { title: "other journey", status: "passed", messages: [] },
      ),
      1,
    ),
  ).toEqual({
    kind: "screenshots-differ",
    specs: ["capture landing product screenshots"],
  });
});

test("a functional failure still fails, even beside a screenshot difference", () => {
  expect(
    verdictOf(
      report({
        title: "capture landing product screenshots",
        status: "failed",
        messages: [MISMATCH, "Error: expect(locator).toBeVisible() failed"],
      }),
      1,
    ).kind,
  ).toBe("fail");
});

test("a timeout, a crash or a global error is never a screenshot difference", () => {
  expect(
    verdictOf(
      report({ title: "capture", status: "timedOut", messages: [MISMATCH] }),
      1,
    ).kind,
  ).toBe("fail");
  expect(
    verdictOf({ ...report(), errors: [{ message: "worker crashed" }] }, 1).kind,
  ).toBe("fail");
  expect(verdictOf(report(), 1).kind).toBe("fail");
  expect(verdictOf(undefined, 1).kind).toBe("fail");
});

test("a screenshot that never stabilised is a failure, not a difference", () => {
  expect(
    verdictOf(
      report({
        title: "capture landing product screenshots",
        status: "failed",
        messages: [
          "Error: expect(page).toHaveScreenshot(expected) failed\n\n  Timeout 15000ms exceeded.\n  - 2 consecutive screenshots were not stable",
        ],
      }),
      1,
    ).kind,
  ).toBe("fail");
});

test("an unexpected pass beside a screenshot difference still fails", () => {
  expect(
    verdictOf(
      report(
        {
          title: "capture landing product screenshots",
          status: "failed",
          messages: [MISMATCH],
        },
        {
          title: "expected to fail",
          status: "passed",
          messages: [],
          testStatus: "unexpected",
        },
      ),
      1,
    ).kind,
  ).toBe("fail");
});

test("a passing run passes", () => {
  expect(verdictOf(undefined, 0)).toEqual({ kind: "pass" });
});

// The capture step runs the script itself: its exit code decides the
// screenshots job, and a failed screenshots job blocks a release.
const runVerdict = (playwrightReport: unknown, exitCode: number) => {
  const directory = mkdtempSync(path.join(tmpdir(), "marketing-verdict-"));
  try {
    const reportPath = path.join(directory, "report.json");
    if (playwrightReport !== undefined) {
      writeFileSync(reportPath, JSON.stringify(playwrightReport));
    }
    const summaryPath = path.join(directory, "summary.md");
    const child = Bun.spawnSync(
      [
        process.execPath,
        path.join(import.meta.dir, "marketing-screenshot-verdict.ts"),
        reportPath,
        String(exitCode),
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          GITHUB_STEP_SUMMARY: summaryPath,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      summary: existsSync(summaryPath)
        ? readFileSync(summaryPath, "utf-8")
        : "",
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

test("the step passes a difference-only report with a warning", () => {
  const run = runVerdict(
    report({
      title: "capture landing product screenshots",
      status: "failed",
      messages: [MISMATCH],
    }),
    1,
  );
  expect(run.exitCode, run.stdout).toBe(0);
  expect(run.stdout).toContain(
    "::warning title=Marketing screenshots differ::",
  );
  expect(run.stdout).toContain("capture landing product screenshots");
  expect(run.stdout).not.toContain("::error");
  expect(run.summary).toContain("Marketing screenshots differ");
});

test.each([
  [
    "a failed assertion",
    report({
      title: "capture landing product screenshots",
      status: "failed",
      messages: ["Error: expect(locator).toBeVisible() failed"],
    }),
  ],
  [
    "a timeout",
    report({ title: "capture", status: "timedOut", messages: [MISMATCH] }),
  ],
  ["a crashed page", { ...report(), errors: [{ message: "page crashed" }] }],
  [
    "a page that never settled",
    report({
      title: "capture landing product screenshots",
      status: "failed",
      messages: [
        "Error: expect(page).toHaveScreenshot(expected) failed\n\n  Timeout 15000ms exceeded.\n  - 2 consecutive screenshots were not stable",
      ],
    }),
  ],
  ["an unreadable report", undefined],
])("the step fails on %s", (_label, playwrightReport) => {
  const run = runVerdict(playwrightReport, 1);
  expect(run.exitCode, run.stdout).toBe(1);
  expect(run.stdout).toContain(
    "::error title=Marketing screenshot check failed::",
  );
  expect(run.stdout).not.toContain("::warning");
});
