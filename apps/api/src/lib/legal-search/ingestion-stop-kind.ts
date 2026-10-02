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
