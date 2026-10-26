import { expect, test } from "bun:test";

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
