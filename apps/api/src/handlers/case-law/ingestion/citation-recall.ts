import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";

/**
 * Which of the publisher's own cited-decision list the extractor missed.
 *
 * Courts that publish structured "cites" metadata are the only ground truth
 * the extractor can be measured against without measuring it against itself:
 * a non-empty gap at ingest time means a citation shape the patterns do not
 * cover, and is escalated as a structured event for the citation-quality
 * routine to turn into a new pattern or a delegated classification.
 */
export const publisherCitationGap = ({
  extracted,
  publisherCited,
}: {
  extracted: readonly string[];
  publisherCited: readonly string[];
}): string[] => {
  const have = new Set(extracted.map(bareCitationKey));
  return publisherCited.filter((cited) => {
    const trimmed = cited.trim();
    return trimmed.length > 0 && !have.has(bareCitationKey(trimmed));
  });
};
