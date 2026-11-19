// parser-output-unchanged: Stop dispositions classify cycle failures; parsed decision output is unchanged.
export const INGESTION_STOP_KIND = {
  SOURCE_UNREACHABLE: "source_unreachable",
  PUBLISHER_REFUSAL: "publisher_refusal",
  ADAPTER_ERROR: "adapter_error",
  DEADLINE: "deadline",
  INTERNAL_ERROR: "internal_error",
} as const;

export type IngestionStopKind =
  (typeof INGESTION_STOP_KIND)[keyof typeof INGESTION_STOP_KIND];

export const CYCLE_OUTCOMES = [
  "completed",
  "paused",
  "failed",
  "timeout",
] as const;
export type CycleOutcome = (typeof CYCLE_OUTCOMES)[number];

export const CYCLE_OUTCOME = {
  COMPLETED: "completed",
  PAUSED: "paused",
  FAILED: "failed",
  TIMEOUT: "timeout",
} as const satisfies {
  [Outcome in CycleOutcome as Uppercase<Outcome>]: Outcome;
};

export const INGESTION_PAUSE_REASON = {
  DECISION_ALLOWANCE_EXHAUSTED: "decision_allowance_exhausted",
} as const;

export type IngestionPauseReason =
  (typeof INGESTION_PAUSE_REASON)[keyof typeof INGESTION_PAUSE_REASON];

export type IngestionCycleTermination =
  | {
      outcome: typeof CYCLE_OUTCOME.COMPLETED;
      stopKind?: never;
      pauseReason?: never;
    }
  | {
      outcome: typeof CYCLE_OUTCOME.PAUSED;
      pauseReason: IngestionPauseReason;
      stopKind?: never;
    }
  | {
      outcome: typeof CYCLE_OUTCOME.FAILED | typeof CYCLE_OUTCOME.TIMEOUT;
      stopKind: IngestionStopKind;
      pauseReason?: never;
    };

/** Source availability is measured separately from defects. */
export const INGESTION_STOP_DISPOSITION = {
  [INGESTION_STOP_KIND.SOURCE_UNREACHABLE]: "source_unavailable",
  [INGESTION_STOP_KIND.PUBLISHER_REFUSAL]: "source_unavailable",
  [INGESTION_STOP_KIND.ADAPTER_ERROR]: "defect",
  [INGESTION_STOP_KIND.DEADLINE]: "defect",
  [INGESTION_STOP_KIND.INTERNAL_ERROR]: "defect",
} as const satisfies Record<IngestionStopKind, "source_unavailable" | "defect">;

type IngestionPipelineCounts = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  s3UploadFailures: number;
  pagesProcessed: number;
  nextCursor: string | null;
};

export type IngestionPipelineResult = IngestionPipelineCounts &
  (
    | (Extract<
        IngestionCycleTermination,
        { outcome: typeof CYCLE_OUTCOME.COMPLETED }
      > & { haltReason: null })
    | (Exclude<
        IngestionCycleTermination,
        { outcome: typeof CYCLE_OUTCOME.COMPLETED }
      > & { haltReason: string })
  );

export const CYCLE_HALT_REASON = {
  TIMEOUT: "Cycle timeout exceeded",
} as const;
