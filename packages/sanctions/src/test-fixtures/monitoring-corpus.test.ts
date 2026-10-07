import { expect, test } from "bun:test";

import { syntheticMonitoringName } from "./monitoring-corpus";

test("synthetic monitoring names retain their corpus identities", () => {
  expect([0, 1, 19_999].map(syntheticMonitoringName)).toEqual([
    "kkpihakkflbkahbk bapjblaaglminedp",
    "hdcfjfnffmhkncmm loglgikfeehdaoin",
    "anbhlmcfmmgomlfi jbgjdcighkbiklho",
  ]);
});
