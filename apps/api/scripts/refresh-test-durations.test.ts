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
