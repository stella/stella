export const INGESTION_FAILURE_IDENTITY_KIND = {
  SOURCE_DOCUMENT: "source-document",
  PROVIDED_RECORD: "provided-record",
  CAPTURED_INPUT: "captured-input",
} as const;

export type IngestionFailureIdentityKind =
  (typeof INGESTION_FAILURE_IDENTITY_KIND)[keyof typeof INGESTION_FAILURE_IDENTITY_KIND];

// A named first value preserves Drizzle's required nonempty tuple.
export const INGESTION_FAILURE_IDENTITY_KINDS = [
  INGESTION_FAILURE_IDENTITY_KIND.SOURCE_DOCUMENT,
  ...Object.values(INGESTION_FAILURE_IDENTITY_KIND).filter(
    (kind) => kind !== INGESTION_FAILURE_IDENTITY_KIND.SOURCE_DOCUMENT,
  ),
] as const;
