import { expect, test } from "bun:test";

import { readTestDurations } from "./refresh-test-durations";

test("reporter timings remain attached to their file across plain and grouped CI logs", () => {
  const result = readTestDurations(
    [
      "src/one.test.ts:",
      "(pass) first test [100ms]",
      "(pass) second test [2s]",
      "2026-10-01T10:00:41Z ##[group]scripts/two.test.ts:",
      "2026-10-01T10:00:41Z (pass) third test [500ms]",
      "evals/empty.test.ts:",
    ].join("\n"),
  );
  expect(result.files).toEqual({
    "src/one.test.ts": 2.1,
    "scripts/two.test.ts": 0.5,
    "evals/empty.test.ts": 0,
  });
  expect(
    result.slowestTests.map(({ file, seconds }) => ({ file, seconds })),
  ).toEqual([
    { file: "src/one.test.ts", seconds: 2 },
    { file: "scripts/two.test.ts", seconds: 0.5 },
    { file: "src/one.test.ts", seconds: 0.1 },
  ]);
});

// Copied from ci-tests (api-1); exercise Turbo's streamed prefix as well as
// GitHub's grouped rendering of the same reporter output.
const ciHeader =
  "2026-10-01T17:20:16.2581603Z ##[group]src/db/legislation-expression-identity.db.test.ts:";
const ciTiming =
  "2026-10-01T17:20:16.2582126Z (pass) legislation expression identity columns > an existing row reads as an effective consolidation with no id [13.45ms]";

test.each([
  ciHeader,
  ciHeader.replace("##[group]", "@stll/api:test: "),
  ciHeader.replace("##[group]", "@stll/api:test: ##[group]"),
  ciHeader.replace(
    "2026-10-01T17:20:16.2581603Z ##[group]",
    "@stll/api:test: ",
  ),
])("CI reporter header %s retains its test timing", (header) => {
  const result = readTestDurations(`${header}\n${ciTiming}`);
  expect(result.files).toEqual({
    "src/db/legislation-expression-identity.db.test.ts": 0.01345,
  });
  expect(result.slowestTests).toEqual([
    {
      file: "src/db/legislation-expression-identity.db.test.ts",
      test: "legislation expression identity columns > an existing row reads as an effective consolidation with no id",
      seconds: 0.01345,
    },
  ]);
});
