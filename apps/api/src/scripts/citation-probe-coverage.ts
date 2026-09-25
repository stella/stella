/**
 * Coverage check for the citation probe: does an extracted citation already
 * account for a detector candidate?
 *
 * Both sides normalize (prefix stripped, separators collapsed) before the
 * containment check: the extractor dedups sp. zn. and č. j. spellings of one
 * case number to a single entry, and neither the surviving prefix nor the
 * separator spelling ("8 C/18/2008" vs "8 C 18/2008") may decide coverage.
 */
const citationKey = (value: string): string =>
  value
    .replace(
      /^(?:sp\.\s{0,3}zn\.:?|sen\.\s{0,3}zn\.:?|sygn\.(?:\s{1,3}akt)?|[čc]\.\s{0,3}j\.:?)\s{0,3}/iu,
      "",
    )
    .replaceAll(/[\s/]+/gu, " ")
    .toLowerCase()
    .trim();

export const citationCoverage = (
  extractedCitationTexts: readonly string[],
): ((candidate: string) => boolean) => {
  const extractedKeys = extractedCitationTexts.map(citationKey);
  return (candidate) => {
    const candidateKey = citationKey(candidate);
    return extractedKeys.some(
      (have) => candidateKey.includes(have) || have.includes(candidateKey),
    );
  };
};
