import { Result } from "better-result";

import type { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { ingestionStopKindOf } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { CYCLE_HALT_REASON } from "@/api/lib/legal-search/cycle-deadline";
import { INGESTION_STOP_KIND } from "@/api/lib/legal-search/ingestion-stop-kind";

import { CYCLE_OUTCOME, type CycleResult } from "./cycle-progress";

type PipelineResult = Awaited<ReturnType<typeof runIngestionPipeline>>;
type ExecuteIngestionCycleOptions = {
  runPipeline: () => Promise<PipelineResult>;
  cursorBefore: string | null;
  recordPages: (pages: number) => void;
};

type CycleExecution = {
  result: PipelineResult | null;
  errorMessage: string | null;
  cycle: CycleResult;
};

/** Owns the pipeline-to-runner transition before event persistence or logging. */
export const executeIngestionCycle = async ({
  runPipeline,
  cursorBefore,
  recordPages,
}: ExecuteIngestionCycleOptions): Promise<CycleExecution> => {
  const execution = await Result.tryPromise({
    try: runPipeline,
    catch: (cause) => cause,
  });
  if (Result.isError(execution)) {
    const { error } = execution;
    return {
      result: null,
      errorMessage:
        `[${errorTag(error)}] ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          2048,
        ),
      cycle: {
        outcome: CYCLE_OUTCOME.FAILED,
        stopKind: ingestionStopKindOf(error),
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
  if (
    result.haltReason === null ||
    result.haltReason.startsWith("Decision cap")
  ) {
    return {
      result,
      errorMessage: null,
      cycle: {
        ...counts,
        outcome: CYCLE_OUTCOME.COMPLETED,
      } satisfies CycleResult,
    };
  }
  if (result.haltReason === CYCLE_HALT_REASON.TIMEOUT) {
    return {
      result,
      errorMessage: result.haltReason.slice(0, 2048),
      cycle: {
        ...counts,
        outcome: CYCLE_OUTCOME.TIMEOUT,
        stopKind: INGESTION_STOP_KIND.DEADLINE,
      } satisfies CycleResult,
    };
  }
  return {
    result,
    errorMessage: result.haltReason.slice(0, 2048),
    cycle: {
      ...counts,
      outcome: CYCLE_OUTCOME.FAILED,
      stopKind: result.stopKind ?? INGESTION_STOP_KIND.INTERNAL_ERROR,
    } satisfies CycleResult,
  };
};
