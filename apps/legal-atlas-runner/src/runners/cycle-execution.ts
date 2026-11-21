import { panic, Result } from "better-result";

import {
  CYCLE_OUTCOME,
  type IngestionPipelineResult,
  type IngestionStopKind,
} from "@stll/legal-atlas/ingestion-cycle";

import type { CycleResult } from "./cycle-progress";

type ExecuteIngestionCycleOptions = {
  runPipeline: () => Promise<IngestionPipelineResult>;
  cursorBefore: string | null;
  recordPages: (pages: number) => void;
  describeFailure: (cause: unknown) => {
    stopKind: IngestionStopKind;
    message: string;
  };
};

type CycleExecution = {
  result: IngestionPipelineResult | null;
  errorMessage: string | null;
  cycle: CycleResult;
};

/** Owns the pipeline-to-runner transition before event persistence or logging. */
export const executeIngestionCycle = async ({
  runPipeline,
  cursorBefore,
  recordPages,
  describeFailure,
}: ExecuteIngestionCycleOptions): Promise<CycleExecution> => {
  const execution = await Result.tryPromise({
    try: runPipeline,
    catch: (cause) => cause,
  });
  if (Result.isError(execution)) {
    const failure = describeFailure(execution.error);
    return {
      result: null,
      errorMessage: failure.message.slice(0, 2048),
      cycle: {
        outcome: CYCLE_OUTCOME.FAILED,
        stopKind: failure.stopKind,
        inserted: 0,
        skipped: 0,
        pagesProcessed: 0,
        cursorAdvanced: false,
      } satisfies CycleResult,
    };
  }
  const result = execution.value;
  recordPages(result.pagesProcessed);
  const counts = {
    inserted: result.inserted,
    skipped: result.skipped,
    pagesProcessed: result.pagesProcessed,
    cursorAdvanced: result.nextCursor !== cursorBefore,
  };
  switch (result.outcome) {
    case CYCLE_OUTCOME.COMPLETED:
      return {
        result,
        errorMessage: null,
        cycle: { ...counts, outcome: CYCLE_OUTCOME.COMPLETED },
      };
    case CYCLE_OUTCOME.PAUSED:
      return {
        result,
        errorMessage: null,
        cycle: {
          ...counts,
          outcome: CYCLE_OUTCOME.PAUSED,
          pauseReason: result.pauseReason,
        },
      };
    case CYCLE_OUTCOME.FAILED:
    case CYCLE_OUTCOME.TIMEOUT:
      return {
        result,
        errorMessage: result.haltReason.slice(0, 2048),
        cycle: {
          ...counts,
          outcome: result.outcome,
          stopKind: result.stopKind,
        },
      };
    default:
      result satisfies never;
      return panic("Unhandled pipeline outcome");
  }
};
