/**
 * Drop a code fence the model wrapped a whole document in. Models asked for
 * raw Markdown routinely return it fenced; the fence is presentation, not part
 * of the file, so it must never reach storage.
 */
export const stripMarkdownFences = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const fencePattern = /^```(?:[a-zA-Z0-9_-]*)\r?\n(?<body>[\s\S]*?)\r?\n```$/u;
  const fenceMatch = fencePattern.exec(trimmed);
  return fenceMatch?.groups?.["body"]?.trim() ?? trimmed;
};
