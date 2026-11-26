export const RECORDING_TRANSCRIPTION_RUN_STATUSES = [
  "queued",
  "transcribing",
  "saving",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RecordingTranscriptionRunStatus =
  (typeof RECORDING_TRANSCRIPTION_RUN_STATUSES)[number];

export const RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES = [
  "queued",
  "transcribing",
  "saving",
] as const satisfies readonly RecordingTranscriptionRunStatus[];

export const RECORDING_TRANSCRIPTION_RUN_SETTLED_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RecordingTranscriptionRunStatus[];

export const RECORDING_TRANSCRIPTION_RUN_ERROR_CODES = [
  "document_unresolved",
  "document_changed",
  "unsupported_format",
  "too_long",
  "no_speech",
  "provider_unavailable",
  "transcription_failed",
  "internal",
] as const;
export type RecordingTranscriptionRunErrorCode =
  (typeof RECORDING_TRANSCRIPTION_RUN_ERROR_CODES)[number];
