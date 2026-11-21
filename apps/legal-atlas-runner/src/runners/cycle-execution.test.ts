import { describe, expect, test } from "bun:test";

import {
  CYCLE_HALT_REASON,
  CYCLE_OUTCOME,
  INGESTION_PAUSE_REASON,
  INGESTION_STOP_KIND,
  type IngestionPipelineResult,
  type IngestionStopKind,
} from "@stll/legal-atlas/ingestion-cycle";

import { executeIngestionCycle } from "./cycle-execution";
import {
  INITIAL_STALL_ALERT,
  type StallAlertState,
  stepAdapterCycleHealth,
} from "./cycle-progress";
import { ingestionHealthRecord } from "./ingestion-health";

const pipelineStop = (
  stopKind: IngestionStopKind,
): IngestionPipelineResult => ({
  inserted: 0,
  skipped: 0,
  searchVectorFailures: 0,
  s3UploadFailures: 0,
  pagesProcessed: 0,
  nextCursor: "cursor-1",
  outcome: CYCLE_OUTCOME.FAILED,
  haltReason: "Page fetch failed",
  stopKind,
});

describe("runner cycle and loop wiring", () => {
  test("pipeline stop kinds reach the live loop's latest stalled-source bucket", async () => {
    const stalledAdapters = new Map<string, IngestionStopKind>();
    let stallAlert: StallAlertState = INITIAL_STALL_ALERT;
    const run = async (runPipeline: () => Promise<IngestionPipelineResult>) => {
      const execution = await executeIngestionCycle({
        runPipeline,
        cursorBefore: "cursor-1",
        recordPages: () => undefined,
        describeFailure: () => {
          throw new Error("Resolved pipeline must not classify a failure");
        },
      });
      const step = stepAdapterCycleHealth({
        adapterKey: "test-source",
        cycle: execution.cycle,
        stallAlert,
        stalledAdapters,
        threshold: 5,
      });
      stallAlert = step.stall.state;
      return ingestionHealthRecord({
        uptimeSec: 1,
        pagesSinceStart: 0,
        activeCycles: 0,
        stalledAdapters,
      });
    };
    for (let cycle = 0; cycle < 5; cycle++) {
      await run(async () =>
        pipelineStop(INGESTION_STOP_KIND.SOURCE_UNREACHABLE),
      );
    }
    const health = await run(async () =>
      pipelineStop(INGESTION_STOP_KIND.ADAPTER_ERROR),
    );
    expect(health).toMatchObject({
      stalledAdapterCount: 1,
      sourceUnreachableCount: 0,
      adapterStuckCount: 1,
      stalledAdapterStopKinds: {
        "test-source": INGESTION_STOP_KIND.ADAPTER_ERROR,
      },
    });
    const recovered = await run(async () => ({
      ...pipelineStop(INGESTION_STOP_KIND.INTERNAL_ERROR),
      pagesProcessed: 1,
      nextCursor: "cursor-2",
    }));
    expect(recovered.stalledAdapterCount).toBe(0);
  });

  test("an allowance pause preserves its typed reason and cursor without a health failure", async () => {
    const execution = await executeIngestionCycle({
      runPipeline: async () => ({
        outcome: CYCLE_OUTCOME.PAUSED,
        pauseReason: INGESTION_PAUSE_REASON.DECISION_ALLOWANCE_EXHAUSTED,
        inserted: 1,
        skipped: 0,
        searchVectorFailures: 0,
        s3UploadFailures: 0,
        pagesProcessed: 0,
        nextCursor: "cursor-1",
        haltReason: "An operator-facing allowance message",
      }),
      cursorBefore: "cursor-1",
      recordPages: () => undefined,
      describeFailure: () => {
        throw new Error("A pause must not classify a failure");
      },
    });
    expect(execution.errorMessage).toBeNull();
    expect(execution.cycle).toEqual({
      outcome: CYCLE_OUTCOME.PAUSED,
      pauseReason: INGESTION_PAUSE_REASON.DECISION_ALLOWANCE_EXHAUSTED,
      inserted: 1,
      skipped: 0,
      pagesProcessed: 0,
      cursorAdvanced: false,
    });
    const stalledAdapters = new Map([
      ["test-source", INGESTION_STOP_KIND.ADAPTER_ERROR],
    ]);
    const step = stepAdapterCycleHealth({
      adapterKey: "test-source",
      cycle: execution.cycle,
      stallAlert: { noProgressStreak: 4, captured: true },
      stalledAdapters,
      threshold: 5,
    });
    expect(step.stopKind).toBeNull();
    expect(step.stall.capture).toBe(false);
    expect(step.stall.sustained).toBeNull();
    expect(step.madeProgress).toBe(false);
    expect(stalledAdapters.size).toBe(0);
  });

  test("a classified thrown pipeline error reaches the same loop health transition", async () => {
    const failure = new Error("Publisher unavailable");
    const classified: unknown[] = [];
    const stalledAdapters = new Map<string, IngestionStopKind>();
    const execution = await executeIngestionCycle({
      runPipeline: async () => {
        throw failure;
      },
      cursorBefore: null,
      recordPages: () => undefined,
      describeFailure: (cause) => {
        classified.push(cause);
        return {
          stopKind: INGESTION_STOP_KIND.SOURCE_UNREACHABLE,
          message: failure.message,
        };
      },
    });
    expect(classified).toEqual([failure]);
    expect(execution.errorMessage).toBe(failure.message);
    stepAdapterCycleHealth({
      adapterKey: "test-source",
      cycle: execution.cycle,
      stallAlert: INITIAL_STALL_ALERT,
      stalledAdapters,
      threshold: 1,
    });
    expect(
      ingestionHealthRecord({
        uptimeSec: 1,
        pagesSinceStart: 0,
        activeCycles: 0,
        stalledAdapters,
      }),
    ).toMatchObject({ sourceUnreachableCount: 1, adapterStuckCount: 0 });
  });

  test("internal DB exceptions and cycle deadlines keep different kinds", async () => {
    const internal = await executeIngestionCycle({
      runPipeline: async () => {
        throw new Error("DB write expired");
      },
      cursorBefore: null,
      recordPages: () => undefined,
      describeFailure: () => ({
        stopKind: INGESTION_STOP_KIND.INTERNAL_ERROR,
        message: "DB write expired",
      }),
    });
    expect(internal.cycle.stopKind).toBe(INGESTION_STOP_KIND.INTERNAL_ERROR);
    const deadline = await executeIngestionCycle({
      runPipeline: async () => ({
        inserted: 0,
        skipped: 0,
        searchVectorFailures: 0,
        s3UploadFailures: 0,
        pagesProcessed: 0,
        nextCursor: "cursor-1",
        outcome: CYCLE_OUTCOME.TIMEOUT,
        stopKind: INGESTION_STOP_KIND.DEADLINE,
        haltReason: CYCLE_HALT_REASON.TIMEOUT,
      }),
      cursorBefore: "cursor-1",
      recordPages: () => undefined,
      describeFailure: () => {
        throw new Error("Resolved pipeline must not classify a failure");
      },
    });
    expect(deadline.cycle.stopKind).toBe(INGESTION_STOP_KIND.DEADLINE);
  });
});
