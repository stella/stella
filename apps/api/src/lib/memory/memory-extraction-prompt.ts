/** Encode the only characters capable of opening or closing the XML-like
 * trust delimiter while preserving the summary's readable text for the model.
 */
export const escapeUntrustedPromptContent = (content: string): string =>
  content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const escapeUntrustedSummary = escapeUntrustedPromptContent;

type BuildExtractionPromptOptions = {
  /** Raw compaction summary. */
  summary: string;
  /** Raw transcript of the summarized messages; empty when unavailable. */
  transcript: string;
};

/**
 * Assemble the extraction prompt from the compaction summary and, when it
 * could be recovered, the transcript the summary replaced.
 *
 * Escape both operands at this trust boundary so no caller can accidentally
 * permit user content to close either delimiter. The transcript block is
 * omitted entirely when empty so the model never sees a stray empty section.
 */
export const buildExtractionPrompt = ({
  summary,
  transcript,
}: BuildExtractionPromptOptions): string => {
  const summaryBlock = `<untrusted-summary>\n${escapeUntrustedPromptContent(summary)}\n</untrusted-summary>`;
  if (transcript.length === 0) {
    return summaryBlock;
  }
  return `${summaryBlock}\n<untrusted-transcript>\n${escapeUntrustedPromptContent(transcript)}\n</untrusted-transcript>`;
};
