import { expect, test } from "bun:test";
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
        const missing = files.at(offset % files.length);
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

test("available whole-file measurements reject stale weights in either direction", () => {
  for (const [recorded, measured] of [
    [1, 4.01],
    [4.01, 1],
    [0, 5],
  ]) {
    expect(() =>
      assertTestDurations({
        files: ["one"],
        durations: { one: { seconds: recorded ?? 0, source: "measured" } },
        measurements: { one: measured ?? 0 },
      }),
    ).toThrow("Stale API test duration: one");
  }
  for (const [recorded, measured] of [
    [1, 4],
    [0, 0.9],
    [10, 2.5],
  ]) {
    assertTestDurations({
      files: ["one"],
      durations: { one: { seconds: recorded ?? 0, source: "measured" } },
      measurements: { one: measured ?? 0 },
    });
  }
  assertTestDurations({
    files: ["one"],
    durations: { one: { seconds: 1, source: "measured" } },
    measurements: { deleted: 999 },
  });
  assertTestDurations({
    files: ["one"],
    durations: { one: { seconds: 1, source: "estimated" } },
    measurements: { one: 100 },
  });
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
