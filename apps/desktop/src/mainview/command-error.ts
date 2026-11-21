/**
 * The message to show for a failed native command. Tauri rejects `invoke`
 * with the command's error string, not an `Error`, so a check for `Error`
 * alone replaced every real reason with the generic fallback.
 */
export const commandErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
};
