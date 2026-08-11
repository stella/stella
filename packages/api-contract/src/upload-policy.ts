/**
 * Shared boundary for direct document uploads. Clients, the API reservation,
 * and the presigned URL must all cover the same supported transfer window.
 */
export const DOCUMENT_UPLOAD_POLICY = {
  maxBytes: 52_428_800, // 50 MiB
  minimumBytesPerSecond: 32_768, // 32 KiB/s
  putTimeoutMs: 1_800_000, // 30 minutes
} as const;
