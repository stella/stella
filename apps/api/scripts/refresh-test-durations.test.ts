import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listApiTestPaths } from "./api-test-plan";
import { planPostgresTestShards } from "./postgres-test-shards";
import {
  refreshedTestDurations,
  serializeTestDurations,
} from "./refresh-test-durations";

const base = JSON.stringify({
  deleted: { seconds: 9, source: "measured" },
  unmeasured: { seconds: 1.5, source: "measured" },
  replaced: { seconds: 1, source: "measured" },
});

test("aggregation carries live weights forward, replaces measurements, and drops deleted files", () => {
  const refreshed = refreshedTestDurations(
    ["new", "replaced", "unmeasured"],
    base,
    [
      '{"version":1,"files":{"new":2300,"replaced":2000}}',
      '{"version":1,"files":{"replaced":4000}}',
    ],
  );
  expect(refreshed).toEqual({
    new: { seconds: 2.3, source: "measured", history: [2.3] },
    replaced: { seconds: 2, source: "measured", history: [1, 2, 4] },
    unmeasured: { seconds: 1.5, source: "measured", history: [1.5] },
  });
});

test("serialization is byte-stable for shuffled inputs", () => {
  const first = refreshedTestDurations(
    ["new", "replaced", "unmeasured"],
    base,
    ['{"version":1,"files":{"new":2300,"replaced":4000}}'],
  );
  const shuffled = refreshedTestDurations(
    ["unmeasured", "replaced", "new"],
    JSON.stringify({
      replaced: { seconds: 1, source: "measured" },
      unmeasured: { seconds: 1.5, source: "measured" },
      deleted: { seconds: 9, source: "measured" },
    }),
    ['{"version":1,"files":{"replaced":4000,"new":2300}}'],
  );
  expect(serializeTestDurations(shuffled)).toBe(serializeTestDurations(first));
});

test("an unreadable previous weights file is ignored, not fatal", () => {
  for (const unreadable of [
    "{",
    '{"old":{"seconds":1,"source":"estimated"}}',
  ]) {
    expect(
      refreshedTestDurations(["new"], unreadable, [
        '{"version":1,"files":{"new":1000}}',
      ]),
    ).toEqual({ new: { seconds: 1, source: "measured", history: [1] } });
  }
});

test("a main run whose shards all replay cached results carries the base forward", () => {
  const live = listApiTestPaths(path.resolve(import.meta.dir, "..")).at(0);
  if (live === undefined) {
    throw new Error("expected at least one live API test file");
  }
  const root = mkdtempSync(path.join(tmpdir(), "api-test-durations-"));
  try {
    const timings = path.join(root, "timings");
    mkdirSync(timings);
    const basePath = path.join(root, "base.json");
    const destination = path.join(root, "out.json");
    writeFileSync(
      basePath,
      JSON.stringify({
        [live]: { seconds: 3, source: "measured" },
        "deleted.test.ts": { seconds: 9, source: "measured" },
      }),
    );
    const result = Bun.spawnSync([
      process.execPath,
      path.join(import.meta.dir, "refresh-test-durations.ts"),
      "--write",
      destination,
      "--base",
      basePath,
      timings,
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(destination, "utf-8"))).toEqual({
      [live]: { seconds: 3, source: "measured", history: [3] },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history is bounded and the weight is the median of the recent samples", () => {
  const artifacts = [1, 2, 3, 4, 5, 6, 7].map(
    (seconds) => `{"version":1,"files":{"a":${seconds * 1000}}}`,
  );
  const refreshed = refreshedTestDurations(["a"], undefined, artifacts);
  expect(refreshed["a"]?.history).toEqual([3, 4, 5, 6, 7]);
  expect(refreshed["a"]?.seconds).toBe(5);
});

test("one outlier run does not change the shard plan", () => {
  const files = ["a", "b", "c", "d"];
  const stable = JSON.stringify(
    Object.fromEntries(
      files.map((file) => [
        file,
        { seconds: 100, source: "measured", history: [100, 100, 100, 100] },
      ]),
    ),
  );
  const plan = (durations: ReturnType<typeof refreshedTestDurations>) =>
    planPostgresTestShards({
      files,
      durations: Object.fromEntries(
        Object.entries(durations).map(([file, { seconds }]) => [file, seconds]),
      ),
      count: 2,
    });
  const calm = refreshedTestDurations(files, stable, [
    '{"version":1,"files":{"a":100000,"b":100000,"c":100000,"d":100000}}',
  ]);
  const outlier = refreshedTestDurations(files, stable, [
    '{"version":1,"files":{"a":900000,"b":100000,"c":100000,"d":100000}}',
  ]);
  expect(outlier["a"]?.seconds).toBe(100);
  expect(plan(outlier)).toEqual(plan(calm));
});
