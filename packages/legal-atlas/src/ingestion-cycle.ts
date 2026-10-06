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

/** Source availability is measured separately from defects. */
export const INGESTION_STOP_DISPOSITION = {
  [INGESTION_STOP_KIND.SOURCE_UNREACHABLE]: "source_unavailable",
  [INGESTION_STOP_KIND.PUBLISHER_REFUSAL]: "source_unavailable",
  [INGESTION_STOP_KIND.ADAPTER_ERROR]: "defect",
  [INGESTION_STOP_KIND.DEADLINE]: "defect",
  [INGESTION_STOP_KIND.INTERNAL_ERROR]: "defect",
} as const satisfies Record<IngestionStopKind, "source_unavailable" | "defect">;

export type IngestionPipelineResult = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  s3UploadFailures: number;
  pagesProcessed: number;
  nextCursor: string | null;
  /** Non-null if the adapter was halted early due to repeated failures. */
  haltReason: string | null;
  stopKind?: IngestionStopKind;
};

export const CYCLE_HALT_REASON = {
  TIMEOUT: "Cycle timeout exceeded",
} as const;
