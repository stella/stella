export const OUTLOOK_INGESTION_OUTCOMES = [
  "in_progress",
  "complete",
  "retryable_failure",
  "terminal_failure",
] as const;

export type OutlookIngestionOutcome =
  (typeof OUTLOOK_INGESTION_OUTCOMES)[number];

export const OUTLOOK_INGESTION_RETRY_STAGES = [
  "none",
  "reserve",
  "upload",
  "finalize",
  "abort",
  "reconcile",
] as const;

export type OutlookIngestionRetryStage =
  (typeof OUTLOOK_INGESTION_RETRY_STAGES)[number];

export const OUTLOOK_INGESTION_HOSTS = ["Outlook"] as const;
export type OutlookIngestionHost = (typeof OUTLOOK_INGESTION_HOSTS)[number];

export const OUTLOOK_INGESTION_PLATFORMS = [
  "Android",
  "iOS",
  "Mac",
  "OfficeOnline",
  "PC",
  "Universal",
] as const;
export type OutlookIngestionPlatform =
  (typeof OUTLOOK_INGESTION_PLATFORMS)[number];

export const OUTLOOK_HOST_VERSION_PATTERN = /^\d{1,4}(?:\.\d{1,6}){1,3}$/u;

export const OUTLOOK_MAILBOX_REQUIREMENT_SET = {
  name: "Mailbox",
  version: "1.8",
} as const;

/**
 * Metadata-only diagnostics for one Outlook email-ingestion attempt.
 *
 * This allowlist deliberately excludes message, mailbox, item, attachment,
 * filename, address, subject, and body identifiers or content. The trace ID
 * is generated per attempt and is not persisted by the client.
 */
export type OutlookIngestionDiagnostic = {
  aggregateAttachmentBytes: number | null;
  attachmentCount: number;
  host: OutlookIngestionHost | null;
  hostVersion: string | null;
  mailboxRequirementSetSupported: boolean | null;
  outcome: OutlookIngestionOutcome;
  platform: OutlookIngestionPlatform | null;
  retryStage: OutlookIngestionRetryStage;
  traceId: string;
};
