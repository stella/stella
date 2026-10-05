import { panic } from "better-result";
import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { selectApiTestFiles } from "./test-file-shards";
import { assertTestDurations, readTimingArtifact } from "./test-timings";

test("every selected shard file needs a weight before execution", () => {
  expect(() =>
    selectApiTestFiles({
      files: ["new.test.ts"],
      durations: {},
      shardValue: "1/1",
    }),
  ).toThrow("Missing API test duration: new.test.ts");
  assertTestDurations({
    files: ["one.test.ts"],
    durations: { "one.test.ts": { seconds: 0, source: "measured" } },
  });
});

test("removing any live weight prevents every shard from starting", () => {
  assertProperty(
    "removing any live weight prevents every shard from starting",
    fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/u), {
        minLength: 1,
        maxLength: 20,
      }),
      fc.nat(),
      (files, offset) => {
        const missing =
          files.at(offset % files.length) ??
          panic("Nonempty file generator must select an existing file");
        const durations = Object.fromEntries(
          files
            .filter((file) => file !== missing)
            .map((file) => [
              file,
              { seconds: 1, source: "estimated" as const },
            ]),
        );
        for (const index of [1, 2]) {
          expect(() =>
            selectApiTestFiles({ files, durations, shardValue: `${index}/2` }),
          ).toThrow(`Missing API test duration: ${missing}`);
        }
      },
    ),
  );
});

test("measured drift warns only above both noise floors and never rejects execution", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const [recorded, measured] of [
      [2, 12],
      [12, 2],
      [0, 10],
    ] as const) {
      warning.mockClear();
      assertTestDurations({
        files: ["one"],
        durations: { one: { seconds: recorded, source: "measured" } },
        measurements: { one: measured },
      });
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls.at(0)?.at(0)).toContain(
        "::warning::Stale API test duration: one",
      );
      expect(warning.mock.calls.at(0)?.at(0)).toContain(
        "--write <timing-artifact-directory>",
      );
    }
    for (const [recorded, measured] of [
      [1, 6],
      [6, 1],
      [10, 40],
      [0, 0.9],
    ] as const) {
      warning.mockClear();
      assertTestDurations({
        files: ["one"],
        durations: { one: { seconds: recorded, source: "measured" } },
        measurements: { one: measured },
      });
      expect(warning).not.toHaveBeenCalled();
    }
    warning.mockClear();
    assertTestDurations({
      files: ["one"],
      durations: { one: { seconds: 1, source: "estimated" } },
      measurements: { one: 100, deleted: 999 },
    });
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test("a sixfold measured drift exits zero with a warning while a missing weight fails", async () => {
  const cases = [
    {
      durations: { one: { seconds: 2, source: "measured" } },
      exitCode: 0,
      message: "::warning::Stale API test duration: one",
    },
    { durations: {}, exitCode: 1, message: "Missing API test duration: one" },
  ];
  for (const { durations, exitCode, message } of cases) {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { assertTestDurations } from "./test-timings.ts"; assertTestDurations(${JSON.stringify({ files: ["one"], durations, measurements: { one: 12 } })});`,
      ],
      { cwd: import.meta.dirname, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(exitCode);
    expect(stderr).toContain(message);
    expect(stderr).toContain(
      "bun apps/api/scripts/refresh-test-durations.ts --write",
    );
  }
});

test("invalid recorded weights and measurements remain hard failures for both sources", () => {
  for (const source of ["measured", "estimated"] as const) {
    for (const invalid of [-1, Infinity, Number.NaN]) {
      expect(() =>
        assertTestDurations({
          files: ["one"],
          durations: { one: { seconds: invalid, source } },
        }),
      ).toThrow("Invalid duration");
      expect(() =>
        assertTestDurations({
          files: ["one"],
          durations: { one: { seconds: 1, source } },
          measurements: { one: invalid },
        }),
      ).toThrow("Invalid measurement");
    }
  }
});

test("native milliseconds normalize to seconds and malformed artifacts fail", () => {
  expect(
    readTimingArtifact('{"version":1,"files":{"./src/one.test.ts":2300}}'),
  ).toEqual({ "src/one.test.ts": 2.3 });
  for (const files of [{ one: -1 }, { one: "10" }]) {
    expect(() =>
      readTimingArtifact(JSON.stringify({ version: 1, files })),
    ).toThrow("Invalid");
  }
  expect(() => readTimingArtifact('{"version":2,"files":{}}')).toThrow(
    "Invalid",
  );
});
