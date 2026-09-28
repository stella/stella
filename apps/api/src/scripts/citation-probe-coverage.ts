import { stripCitationPrefix } from "@stll/legal-ast/citation-prefix";

import {
  bareCitationKey,
  extractCitations,
} from "@/api/handlers/case-law/ingestion/citation-extractor";

/** Whether an extracted citation already accounts for a probe candidate. */
export const citationCoverage = (
  extractedCitationTexts: readonly string[],
): ((candidate: string) => boolean) => {
  const extractedKeys = new Set(extractedCitationTexts.map(bareCitationKey));
  return (candidate) => {
    if (extractedCitationTexts.some((text) => candidate.startsWith(text))) {
      return true;
    }
    // The extractor may store a case number without the prefix the candidate
    // carries, so both sides are compared bare.
    const bareCandidate = stripCitationPrefix(candidate);
    return extractCitations([{ index: 0, text: candidate }]).some(
      (citation) =>
        bareCandidate.startsWith(stripCitationPrefix(citation.citationText)) &&
        extractedKeys.has(bareCitationKey(citation.citationText)),
    );
  };
};
