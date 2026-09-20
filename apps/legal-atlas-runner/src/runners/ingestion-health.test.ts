import { describe, expect, test } from "bun:test";

import {
  INGESTION_HEALTH_MESSAGE,
  ingestionHealthRecord,
} from "./ingestion-health";

describe("ingestion health record", () => {
  test("reports the current distinct stalled sources as a gauge", () => {
    expect(
      ingestionHealthRecord({
        uptimeSec: 42,
        pagesSinceStart: 7,
        activeCycles: 2,
        stalledAdapters: new Set(["pl-courts", "cz-us"]),
      }),
    ).toEqual({
      message: INGESTION_HEALTH_MESSAGE,
      uptimeSec: 42,
      pagesSinceStart: 7,
      activeCycles: 2,
      stalledAdapterCount: 2,
      stalledAdapters: "cz-us,pl-courts",
    });
  });

  test("emits an explicit healthy zero", () => {
    expect(
      ingestionHealthRecord({
        uptimeSec: 1,
        pagesSinceStart: 0,
        activeCycles: 0,
        stalledAdapters: new Set(),
      }),
    ).toMatchObject({ stalledAdapterCount: 0, stalledAdapters: "none" });
  });
});
