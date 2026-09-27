/** Whether an extracted citation already accounts for a probe candidate. */
import {
  bareCitationKey,
  extractCitations,
} from "@/api/handlers/case-law/ingestion/citation-extractor";

export const citationCoverage = (
  extractedCitationTexts: readonly string[],
): ((candidate: string) => boolean) => {
  const extractedKeys = new Set(extractedCitationTexts.map(bareCitationKey));
  return (candidate) => {
    if (extractedCitationTexts.some((text) => candidate.includes(text))) {
      return true;
    }
    return extractCitations([{ index: 0, text: candidate }]).some((citation) =>
      extractedKeys.has(bareCitationKey(citation.citationText)),
    );
  };
};
