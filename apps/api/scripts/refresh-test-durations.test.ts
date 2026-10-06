import { expect, test } from "bun:test";

import {
  estimateMissingTestDurations,
  refreshedTestDurations,
  serializeTestDurations,
} from "./refresh-test-durations";

test("refreshes preserve partial coverage, prefer later artifacts and serialize to a fixed point", () => {
  const first = '{"version":1,"files":{"new":2300,"old":1000}}';
  const last = '{"version":1,"files":{"old":4000}}';
  const refreshed = refreshedTestDurations(
    { untouched: { seconds: 3, source: "estimated" } },
    [first, last],
  );
  expect(refreshed).toEqual({
    new: { seconds: 2.3, source: "measured" },
    old: { seconds: 4, source: "measured" },
    untouched: { seconds: 3, source: "estimated" },
  });
  const serialized = serializeTestDurations(refreshed);
  expect(serialized).toBe(
    serializeTestDurations(refreshedTestDurations(refreshed, [first, last])),
  );
  expect(serialized).toBe(
    serializeTestDurations({
      untouched: { seconds: 3, source: "estimated" },
      old: { seconds: 4, source: "measured" },
      new: { seconds: 2.3, source: "measured" },
    }),
  );
});

test("one refresh gives every new live file an explicit estimate without reviving deleted weights", () => {
  const previous = {
    small: { seconds: 2, source: "measured" as const },
    large: { seconds: 4, source: "estimated" as const },
    deleted: { seconds: 999, source: "measured" as const },
  };
  const files = ["new", "small", "large"];
  const refreshed = estimateMissingTestDurations({ files, previous });
  expect(refreshed).toEqual({
    new: { seconds: 4, source: "estimated" },
    small: previous.small,
    large: previous.large,
  });
  expect(estimateMissingTestDurations({ files, previous: refreshed })).toEqual(
    refreshed,
  );
});
