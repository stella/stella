import { describe, expect, test } from "bun:test";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";

import {
  INGESTION_HEALTH_MESSAGE,
  createIngestionHealthRefresh,
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
      internalErrorCount: 0,
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
      internalErrorCount: 0,
    });
  });
});

describe("independent stored-total heartbeat refresh", () => {
  test("a throwing heartbeat cannot stop credential refresh or retry before its next minute", async () => {
    let now = 0;
    let heartbeatAttempts = 0;
    const failure = new Error("heartbeat read unavailable");
    const warnings: unknown[] = [];
    const credentials: string[] = [];
    const refresh = createIngestionHealthRefresh({
      clock: () => now,
      emitStoredTotalHeartbeat: async () => {
        heartbeatAttempts += 1;
        throw failure;
      },
      observeHeartbeatFailure: (error) => {
        warnings.push(error);
      },
      refreshCredentials: async () => {
        credentials.push("s3", "corpus-s3");
      },
    });
    await refresh();
    expect(credentials).toEqual(["s3", "corpus-s3"]);
    expect(heartbeatAttempts).toBe(1);
    expect(warnings).toEqual([failure]);

    now = 59_999;
    await refresh();
    expect(heartbeatAttempts).toBe(1);
    expect(credentials).toHaveLength(4);

    now = 60_000;
    await refresh();
    expect(heartbeatAttempts).toBe(2);
    expect(credentials).toHaveLength(6);
    expect(warnings).toEqual([failure]);
  });

  test("a successful retry resumes heartbeats on the same bounded cadence", async () => {
    let now = 0;
    let heartbeatAttempts = 0;
    let credentialRefreshes = 0;
    const warnings: unknown[] = [];
    const refresh = createIngestionHealthRefresh({
      clock: () => now,
      emitStoredTotalHeartbeat: async () => {
        heartbeatAttempts += 1;
        if (heartbeatAttempts === 1) {
          throw new Error("heartbeat read unavailable");
        }
      },
      observeHeartbeatFailure: (error) => {
        warnings.push(error);
      },
      refreshCredentials: async () => {
        credentialRefreshes += 1;
      },
    });
    await refresh();
    now = 60_000;
    await refresh();
    now = 119_999;
    await refresh();
    expect(heartbeatAttempts).toBe(2);
    now = 120_000;
    await refresh();
    expect(heartbeatAttempts).toBe(3);
    expect(credentialRefreshes).toBe(4);
    expect(warnings).toHaveLength(1);
  });

  test("each failure episode is observed once, and an outage after recovery is observed again", async () => {
    let now = 0;
    const outcomes = ["fail", "fail", "ok", "fail", "fail"];
    const failures = outcomes.map((_, minute) => new Error(`minute ${minute}`));
    const warnings: unknown[] = [];
    const refresh = createIngestionHealthRefresh({
      clock: () => now,
      emitStoredTotalHeartbeat: async () => {
        const minute = now / 60_000;
        if (outcomes[minute] === "fail") {
          throw failures[minute];
        }
      },
      observeHeartbeatFailure: (error) => {
        warnings.push(error);
      },
      refreshCredentials: async () => {},
    });
    for (const minute of outcomes.keys()) {
      now = minute * 60_000;
      await refresh();
    }
    expect(warnings).toEqual([failures[0], failures[3]]);
  });
});
