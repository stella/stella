import { expect, test } from "bun:test";

import {
  refreshedTestDurations,
  serializeTestDurations,
} from "./refresh-test-durations";

test("aggregation prefers later artifacts and serializes canonically", () => {
  const refreshed = refreshedTestDurations([
    '{"version":1,"files":{"new":2300,"old":1000}}',
    '{"version":1,"files":{"old":4000}}',
  ]);
  expect(refreshed).toEqual({
    new: { seconds: 2.3, source: "measured" },
    old: { seconds: 4, source: "measured" },
  });
  expect(serializeTestDurations(refreshed)).toBe(
    '{\n  "new": {\n    "seconds": 2.3,\n    "source": "measured"\n  },\n  "old": {\n    "seconds": 4,\n    "source": "measured"\n  }\n}\n',
  );
});
