import { describe, expect, test } from "bun:test";

import { INGESTION_STOP_KIND } from "@/api/lib/legal-search/ingestion-stop-kind";

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
        stalledAdapters: new Map([
          ["pl-courts", INGESTION_STOP_KIND.PUBLISHER_REFUSAL],
          ["cz-us", INGESTION_STOP_KIND.ADAPTER_ERROR],
        ]),
      }),
    ).toEqual({
      message: INGESTION_HEALTH_MESSAGE,
      uptimeSec: 42,
      pagesSinceStart: 7,
      activeCycles: 2,
      stalledAdapterCount: 2,
      stalledAdapters: "cz-us,pl-courts",
      stalledAdapterStopKinds: {
        "pl-courts": INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
        "cz-us": INGESTION_STOP_KIND.ADAPTER_ERROR,
      },
      sourceUnreachableCount: 0,
      publisherRefusalCount: 1,
      adapterStuckCount: 1,
      deadlineCount: 0,
    });
  });

  test("emits an explicit healthy zero", () => {
    expect(
      ingestionHealthRecord({
        uptimeSec: 1,
        pagesSinceStart: 0,
        activeCycles: 0,
        stalledAdapters: new Map(),
      }),
    ).toMatchObject({
      stalledAdapterCount: 0,
      stalledAdapters: "none",
      stalledAdapterStopKinds: {},
      sourceUnreachableCount: 0,
      publisherRefusalCount: 0,
      adapterStuckCount: 0,
      deadlineCount: 0,
    });
  });
});
