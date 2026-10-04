// parser-output-unchanged: operational stop kinds do not affect stored parser output.
export const INGESTION_STOP_KIND = {
  SOURCE_UNREACHABLE: "source_unreachable",
  PUBLISHER_REFUSAL: "publisher_refusal",
  ADAPTER_ERROR: "adapter_error",
  DEADLINE: "deadline",
  INTERNAL_ERROR: "internal_error",
} as const;

export type IngestionStopKind =
  (typeof INGESTION_STOP_KIND)[keyof typeof INGESTION_STOP_KIND];

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
