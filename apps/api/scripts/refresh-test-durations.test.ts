import { expect, test } from "bun:test";

import {
  addMissingTestDurations,
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

test("missing weights append once and preserve every existing entry byte for byte", () => {
  const original =
    '{\n  "old": { "source": "measured", "seconds": 2.123456789 },\n  "deleted": {"seconds": 999, "source": "estimated"}\n}\n';
  const updated = addMissingTestDurations(original, ["old", "new"]);
  expect(
    updated.startsWith(original.slice(0, original.lastIndexOf("}")).trimEnd()),
  ).toBe(true);
  expect(JSON.parse(updated)).toEqual({
    old: { seconds: 2.123456789, source: "measured" },
    deleted: { seconds: 999, source: "estimated" },
    new: { seconds: 2.123457, source: "estimated" },
  });
  expect(addMissingTestDurations(updated, ["old", "new"])).toBe(updated);
  expect(addMissingTestDurations(original, ["old"])).toBe(original);
});

test("missing weights bootstrap an empty document at one second", () => {
  expect(JSON.parse(addMissingTestDurations("{}\n", ["new"]))).toEqual({
    new: { seconds: 1, source: "estimated" },
  });
});
