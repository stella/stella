import { expect, test } from "bun:test";

import type { backfillHeartbeat } from "@stll/db-load-gate/health";

import {
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";

import { publishBackfillHeartbeats } from "./backfill-heartbeat";

const NOW = Date.parse("2026-10-02T12:00:00Z");

test.each([
  {
    name: "running",
    enabled: true,
    pausedUntil: null,
    heldSince: null,
    age: 0,
    yielded: 0,
    band: "normal",
  },
  {
    name: "persisted hold",
    enabled: true,
    pausedUntil: null,
    heldSince: NOW - 60_000,
    age: 0,
    yielded: 1,
    band: "stop",
  },
  {
    name: "operator pause",
    enabled: true,
    pausedUntil: new Date(NOW + 60_000),
    heldSince: null,
    age: 0,
    yielded: 1,
    band: "stop",
  },
  {
    name: "disabled job",
    enabled: false,
    pausedUntil: null,
    heldSince: null,
    age: 0,
    yielded: 1,
    band: "stop",
  },
  {
    name: "expired pause",
    enabled: true,
    pausedUntil: new Date(NOW),
    heldSince: null,
    age: 0,
    yielded: 0,
    band: "normal",
  },
  {
    name: "freshness boundary",
    enabled: true,
    pausedUntil: null,
    heldSince: null,
    age: SCHEDULER_BACKFILL_CONFIG.maxStalenessMs,
    yielded: 0,
    band: "normal",
  },
  {
    name: "old runnable checkpoint",
    enabled: true,
    pausedUntil: null,
    heldSince: null,
    age: SCHEDULER_BACKFILL_CONFIG.maxStalenessMs + 1,
    yielded: 0,
    band: "normal",
  },
])(
  "$name is represented durably without mutating operator state",
  ({ enabled, pausedUntil, heldSince, age, yielded, band }) => {
    const row = {
      id: SCHEDULER_BACKFILL_IDS.expressionIds,
      enabled,
      pausedUntil,
      batch: {
        heldSince,
        holdCause: heldSince === null ? null : ("load" as const),
      },
      updatedAt: new Date(NOW - age),
    };
    const before = JSON.stringify(row);
    const records: ReturnType<typeof backfillHeartbeat>[] = [];
    publishBackfillHeartbeats({
      rows: [row],
      now: NOW,
      emit: (record) => {
        records.push(record);
      },
    });
    expect(records.find(({ Backfill }) => Backfill === row.id)).toMatchObject({
      BackfillYielded: yielded,
      band,
      heldSince: heldSince ?? (yielded === 1 ? NOW : null),
    });
    expect(JSON.stringify(row)).toBe(before);
  },
);

test("boot and missing checkpoints emit one root EMF gauge per known backfill", () => {
  const records: ReturnType<typeof backfillHeartbeat>[] = [];
  publishBackfillHeartbeats({
    rows: [
      {
        id: SCHEDULER_BACKFILL_IDS.provisionState,
        enabled: true,
        pausedUntil: null,
        batch: null,
        updatedAt: null,
      },
    ],
    now: NOW,
    emit: (record) => {
      records.push(record);
    },
  });
  expect(records.map(({ Backfill }) => Backfill)).toEqual(
    Object.values(SCHEDULER_BACKFILL_IDS),
  );
  for (const record of records) {
    expect(record).toMatchObject({
      BackfillYielded: 1,
      band: "unknown",
      _aws: {
        Timestamp: NOW,
        CloudWatchMetrics: [
          {
            Namespace: "Stella/Backfill",
            Dimensions: [["Backfill"]],
            Metrics: [{ Name: "BackfillYielded", Unit: "Count" }],
          },
        ],
      },
    });
  }
});

test("minute sampling cannot replay transitions and distinguishes load from other holds", () => {
  for (const holdCause of ["load", "other"] as const) {
    const records: ReturnType<typeof backfillHeartbeat>[] = [];
    publishBackfillHeartbeats({
      rows: [
        {
          id: SCHEDULER_BACKFILL_IDS.provisionState,
          enabled: true,
          pausedUntil: null,
          batch: { heldSince: NOW - 60_000, holdCause },
        },
      ],
      now: NOW,
      emit: (record) => {
        records.push(record);
      },
    });
    const record = records.find(
      ({ Backfill }) => Backfill === SCHEDULER_BACKFILL_IDS.provisionState,
    );
    expect(record?.BackfillYielded).toBe(1);
    expect(record?.event).toBeNull();
    expect(record?.reason).toBe(
      holdCause === "load"
        ? "Durable backfill load hold"
        : "Durable backfill priority or health hold",
    );
  }
});
