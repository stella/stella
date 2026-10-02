import { describe, expect, test } from "bun:test";

import type { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import {
  AdapterFetchError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { CYCLE_HALT_REASON } from "@/api/lib/legal-search/cycle-deadline";
import {
  INGESTION_STOP_KIND,
  type IngestionStopKind,
} from "@/api/lib/legal-search/ingestion-stop-kind";

import { executeIngestionCycle } from "./cycle-execution";
import {
  INITIAL_STALL_ALERT,
  type StallAlertState,
  stepAdapterCycleHealth,
} from "./cycle-progress";
import { ingestionHealthRecord } from "./ingestion-health";

type PipelineResult = Awaited<ReturnType<typeof runIngestionPipeline>>;

const pipelineStop = (stopKind: IngestionStopKind): PipelineResult => ({
  inserted: 0,
  skipped: 0,
  searchVectorFailures: 0,
  s3UploadFailures: 0,
  pagesProcessed: 0,
  nextCursor: "cursor-1",
  haltReason: "Page fetch failed",
  stopKind,
});

describe("runner cycle and loop wiring", () => {
  test("pipeline stop kinds reach the live loop's latest stalled-source bucket", async () => {
    const stalledAdapters = new Map<string, IngestionStopKind>();
    let stallAlert: StallAlertState = INITIAL_STALL_ALERT;
    const run = async (runPipeline: () => Promise<PipelineResult>) => {
      const execution = await executeIngestionCycle({
        runPipeline,
        cursorBefore: "cursor-1",
        recordPages: () => undefined,
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

  test("a typed thrown pipeline error reaches the same loop health transition", async () => {
    const stalledAdapters = new Map<string, IngestionStopKind>();
    const execution = await executeIngestionCycle({
      runPipeline: async () => {
        throw new AdapterFetchError({
          message: "Publisher unavailable",
          adapterKey: "cz-ns",
          cursor: null,
          httpStatus: 503,
        });
      },
      cursorBefore: null,
      recordPages: () => undefined,
    });
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
        throw new TimeoutError({
          message: "DB write expired",
          label: "database",
          timeoutMs: 1,
        });
      },
      cursorBefore: null,
      recordPages: () => undefined,
    });
    expect(internal.cycle.stopKind).toBe(INGESTION_STOP_KIND.INTERNAL_ERROR);
    const deadline = await executeIngestionCycle({
      runPipeline: async () => ({
        ...pipelineStop(INGESTION_STOP_KIND.SOURCE_UNREACHABLE),
        haltReason: CYCLE_HALT_REASON.TIMEOUT,
      }),
      cursorBefore: "cursor-1",
      recordPages: () => undefined,
    });
    expect(deadline.cycle.stopKind).toBe(INGESTION_STOP_KIND.DEADLINE);
  });
});
