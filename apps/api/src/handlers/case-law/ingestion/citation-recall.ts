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
}): { publisherCitedCount: number; missed: string[] } => {
  const have = new Set(extracted.map(bareCitationKey));
  // Publisher lists repeat the same decision under spelling variants
  // ("U 1/86" vs "U 1 /86"); the canonical key deduplicates them so the
  // denominator counts decisions, not spellings.
  const canonical = new Map<string, string>();
  for (const cited of publisherCited) {
    const trimmed = cited.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = bareCitationKey(trimmed);
    if (!canonical.has(key)) {
      canonical.set(key, trimmed);
    }
  }
  const missed = [...canonical.entries()]
    .filter(([key]) => !have.has(key))
    .map(([, spelling]) => spelling);
  return { publisherCitedCount: canonical.size, missed };
};
