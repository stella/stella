/** Encode the only characters capable of opening or closing the XML-like
 * trust delimiter while preserving the summary's readable text for the model.
 */
export const escapeUntrustedSummary = (summary: string): string =>
  summary
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

type BuildExtractionPromptOptions = {
  /** Escaped compaction summary. */
  summary: string;
  /** Escaped transcript of the summarized messages; empty when unavailable. */
  transcript: string;
};

/**
 * Assemble the extraction prompt from the compaction summary and, when it
 * could be recovered, the transcript the summary replaced.
 *
 * Both operands must already be escaped: this only frames them in trust
 * delimiters. The transcript block is omitted entirely when empty so the
 * model never sees a stray empty section.
 */
export const buildExtractionPrompt = ({
  summary,
  transcript,
}: BuildExtractionPromptOptions): string => {
  const summaryBlock = `<untrusted-summary>\n${summary}\n</untrusted-summary>`;
  if (transcript.length === 0) {
    return summaryBlock;
  }
  return `${summaryBlock}\n<untrusted-transcript>\n${transcript}\n</untrusted-transcript>`;
};
