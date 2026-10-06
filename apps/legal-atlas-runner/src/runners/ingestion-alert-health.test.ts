import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  INGESTION_STOP_KIND,
  INGESTION_STOP_DISPOSITION,
  type IngestionStopKind,
} from "@stll/legal-atlas/ingestion-cycle";
import { assertProperty } from "@stll/property-testing";

import { CYCLE_OUTCOME, type CycleResult } from "./cycle-progress";
import { createIngestionAlertHealth } from "./ingestion-alert-health";

const failure = (stopKind: IngestionStopKind): CycleResult => ({
  outcome: CYCLE_OUTCOME.FAILED,
  stopKind,
  inserted: 0,
  skipped: 0,
  pagesProcessed: 0,
  cursorAdvanced: false,
});
const recovery = {
  outcome: CYCLE_OUTCOME.COMPLETED,
  inserted: 0,
  skipped: 0,
  pagesProcessed: 0,
  cursorAdvanced: false,
} satisfies CycleResult;

const harness = () => {
  let now = 0;
  const health = createIngestionAlertHealth({
    now: () => now,
    stallThreshold: 5,
    sourceUnavailableAfterMs: 1000,
  });
  return {
    ...health,
    at: (time: number) => {
      now = time;
    },
    snapshot: () =>
      health.record({
        uptimeSec: now / 1000,
        pagesSinceStart: 0,
        activeCycles: 0,
      }),
  };
};

const isSourceUnavailableKind = (kind: IngestionStopKind) =>
  kind === INGESTION_STOP_KIND.SOURCE_UNREACHABLE ||
  kind === INGESTION_STOP_KIND.PUBLISHER_REFUSAL;

describe("ingestion paging disposition", () => {
  for (const kind of Object.values(INGESTION_STOP_KIND)) {
    test(`${kind} has explicit exception and metric eligibility`, () => {
      const health = harness();
      const captures = [];
      for (let cycle = 0; cycle < 15; cycle++) {
        captures.push(health.step("source", failure(kind)).stall.capture);
      }
      const unavailable = isSourceUnavailableKind(kind);
      expect(INGESTION_STOP_DISPOSITION[kind]).toBe(
        unavailable ? "source_unavailable" : "defect",
      );
      expect(captures.filter(Boolean)).toHaveLength(unavailable ? 0 : 1);
      expect(health.snapshot()).toMatchObject({
        stalledAdapterCount: unavailable ? 0 : 1,
        stalledAdapterTotalCount: 1,
        sourceUnavailableCount: unavailable ? 1 : 0,
        sustainedSourceUnavailableCount: 0,
        stalledAdapterHealth: {
          source: unavailable ? "source_unavailable" : "defect",
        },
      });
    });
  }

  test("elapsed threshold ages an outage even between cycles and progress clears it", () => {
    const health = harness();
    health.step("source", failure(INGESTION_STOP_KIND.SOURCE_UNREACHABLE));
    expect(health.snapshot()).toMatchObject({
      sourceUnavailableCount: 1,
      stalledAdapterCount: 0,
    });
    for (let cycle = 0; cycle < 4; cycle++) {
      health.step("source", failure(INGESTION_STOP_KIND.PUBLISHER_REFUSAL));
    }
    health.at(999);
    expect(health.snapshot()).toMatchObject({
      stalledAdapterCount: 0,
      sourceUnavailableAgeMs: { source: 999 },
    });
    health.at(1000);
    expect(health.snapshot()).toMatchObject({
      stalledAdapterCount: 1,
      sustainedSourceUnavailableCount: 1,
    });
    health.step("source", recovery);
    expect(health.snapshot()).toMatchObject({
      stalledAdapterCount: 0,
      sourceUnavailableCount: 0,
      sourceUnavailableAgeMs: {},
      stalledAdapterHealth: {},
    });
    health.step("source", failure(INGESTION_STOP_KIND.SOURCE_UNREACHABLE));
    expect(health.snapshot()).toMatchObject({
      sourceUnavailableAgeMs: { source: 0 },
      sustainedSourceUnavailableCount: 0,
    });
  });

  test("a defect following an outage earns its own exception and recovery re-arms it", () => {
    const health = harness();
    for (let cycle = 0; cycle < 5; cycle++) {
      health.step("source", failure(INGESTION_STOP_KIND.SOURCE_UNREACHABLE));
    }
    expect(
      health.step("source", failure(INGESTION_STOP_KIND.ADAPTER_ERROR)).stall
        .capture,
    ).toBe(true);
    expect(health.snapshot()).toMatchObject({
      sourceUnavailableCount: 0,
      stalledAdapterCount: 1,
    });
    health.step("source", failure(INGESTION_STOP_KIND.SOURCE_UNREACHABLE));
    expect(
      health.step("source", failure(INGESTION_STOP_KIND.ADAPTER_ERROR)).stall
        .capture,
    ).toBe(false);
    health.step("source", recovery);
    for (let cycle = 0; cycle < 4; cycle++) {
      health.step("source", failure(INGESTION_STOP_KIND.INTERNAL_ERROR));
    }
    expect(
      health.step("source", failure(INGESTION_STOP_KIND.INTERNAL_ERROR)).stall
        .capture,
    ).toBe(true);
  });

  test("outages on every threshold boundary cannot hide the defect episode", () => {
    const health = harness();
    const captures = [];
    for (let turn = 1; turn <= 30; turn++) {
      const kind =
        turn % 5 === 0
          ? INGESTION_STOP_KIND.SOURCE_UNREACHABLE
          : INGESTION_STOP_KIND.ADAPTER_ERROR;
      captures.push(health.step("source", failure(kind)).stall.capture);
    }
    expect(captures.filter(Boolean)).toHaveLength(1);
    expect(captures.at(5)).toBe(true);
  });

  test("age alone does not page before the no-progress threshold", () => {
    const health = harness();
    health.step("source", failure(INGESTION_STOP_KIND.SOURCE_UNREACHABLE));
    health.at(1000);
    expect(health.snapshot()).toMatchObject({
      sourceUnavailableCount: 1,
      stalledAdapterCount: 0,
      sustainedSourceUnavailableCount: 0,
    });
  });

  test("mixed stop dispositions preserve accumulated no-progress evidence", () => {
    const health = harness();
    for (const kind of [
      INGESTION_STOP_KIND.SOURCE_UNREACHABLE,
      INGESTION_STOP_KIND.ADAPTER_ERROR,
      INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
      INGESTION_STOP_KIND.DEADLINE,
    ]) {
      expect(health.step("source", failure(kind)).stall.capture).toBe(false);
    }
    expect(
      health.step("source", failure(INGESTION_STOP_KIND.INTERNAL_ERROR)).stall
        .capture,
    ).toBe(true);
    expect(health.snapshot().stalledAdapterCount).toBe(1);
  });

  test("switching from defect to outage removes the paging gauge immediately", () => {
    const health = harness();
    for (let cycle = 0; cycle < 5; cycle++) {
      health.step("source", failure(INGESTION_STOP_KIND.INTERNAL_ERROR));
    }
    expect(health.snapshot().stalledAdapterCount).toBe(1);
    health.step("source", failure(INGESTION_STOP_KIND.SOURCE_UNREACHABLE));
    expect(health.snapshot()).toMatchObject({
      stalledAdapterCount: 0,
      sourceUnavailableCount: 1,
    });
  });

  test("durable page progress clears outages even when the cycle failed", () => {
    const health = harness();
    for (let cycle = 0; cycle < 5; cycle++) {
      health.step("source", failure(INGESTION_STOP_KIND.PUBLISHER_REFUSAL));
    }
    health.at(1000);
    health.step("source", {
      ...failure(INGESTION_STOP_KIND.PUBLISHER_REFUSAL),
      pagesProcessed: 1,
    });
    expect(health.snapshot()).toMatchObject({
      stalledAdapterCount: 0,
      sourceUnavailableCount: 0,
    });
  });

  test("multiple sources retain independent ages and raw stop-kind counts", () => {
    const health = harness();
    for (let cycle = 0; cycle < 5; cycle++) {
      health.step("first", failure(INGESTION_STOP_KIND.SOURCE_UNREACHABLE));
      health.step("defect", failure(INGESTION_STOP_KIND.DEADLINE));
    }
    health.at(500);
    for (let cycle = 0; cycle < 5; cycle++) {
      health.step("second", failure(INGESTION_STOP_KIND.PUBLISHER_REFUSAL));
    }
    health.at(1000);
    expect(health.snapshot()).toMatchObject({
      stalledAdapterCount: 2,
      stalledAdapterTotalCount: 3,
      sourceUnavailableCount: 2,
      sustainedSourceUnavailableCount: 1,
      sourceUnreachableCount: 1,
      publisherRefusalCount: 1,
      deadlineCount: 1,
      sourceUnavailableAgeMs: { first: 1000, second: 500 },
    });
  });

  test("ingestion health sequences preserve capture, paging and latest-cause invariants", () => {
    assertProperty(
      "ingestion health sequences preserve capture, paging and latest-cause invariants",
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...Object.values(INGESTION_STOP_KIND)),
            progress: fc.boolean(),
            elapsed: fc.integer({ min: 0, max: 1500 }),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        (turns) => {
          const health = harness();
          let elapsed = 0;
          let noProgress = 0;
          let captured = false;
          let sourceSince: number | null = null;
          for (const turn of turns) {
            elapsed += turn.elapsed;
            health.at(elapsed);
            const unavailable = isSourceUnavailableKind(turn.kind);
            noProgress = turn.progress ? 0 : noProgress + 1;
            if (turn.progress) {
              captured = false;
              sourceSince = null;
            } else if (unavailable) {
              sourceSince ??= elapsed;
            } else {
              sourceSince = null;
            }
            const shouldCapture = !unavailable && noProgress >= 5 && !captured;
            if (shouldCapture) {
              captured = true;
            }
            const step = health.step(
              "source",
              turn.progress ? recovery : failure(turn.kind),
            );
            expect(step.stall.capture).toBe(shouldCapture);
            const aged = sourceSince !== null && elapsed - sourceSince >= 1000;
            expect(health.snapshot()).toMatchObject({
              stalledAdapterCount:
                noProgress >= 5 && (!unavailable || aged) ? 1 : 0,
              stalledAdapterTotalCount: noProgress >= 5 ? 1 : 0,
              sourceUnavailableCount: !turn.progress && unavailable ? 1 : 0,
              sustainedSourceUnavailableCount:
                noProgress >= 5 && unavailable && aged ? 1 : 0,
              stalledAdapterStopKinds:
                noProgress >= 5 ? { source: turn.kind } : {},
              stalledAdapterHealth: turn.progress
                ? {}
                : { source: unavailable ? "source_unavailable" : "defect" },
            });
          }
        },
      ),
    );
  });
});
