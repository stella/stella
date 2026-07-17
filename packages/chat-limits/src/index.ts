// Size limit for a single chat context-file attachment. Shared between the
// client (drag/drop + file-picker validation) and the server (attachment
// validation) so the two ends can never drift apart.
//
// The megabytes value is the source; the server derives its human-readable
// Elysia limit ("10m") and byte budget from it, and the client validates
// selected files against the byte budget.

/** Max chat context-file attachment size, in whole megabytes. */
export const CHAT_CONTEXT_FILE_MAX_MEGABYTES = 10;

/** Max chat context-file attachment size, in bytes. */
export const CHAT_CONTEXT_FILE_MAX_BYTES =
  CHAT_CONTEXT_FILE_MAX_MEGABYTES * 1024 * 1024;
