import { expect, test } from "bun:test";

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
    new: { seconds: 2.3, source: "measured" },
    replaced: { seconds: 4, source: "measured" },
    unmeasured: { seconds: 1.5, source: "measured" },
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
    ).toEqual({ new: { seconds: 1, source: "measured" } });
  }
});
