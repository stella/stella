/**
 * Coverage matcher for the citation probe: decides whether a detector
 * candidate is already represented by an extracted citation.
 */

/**
 * Both sides normalize (prefix stripped, whitespace collapsed) before the
 * containment check: the extractor dedups sp. zn. and č. j. spellings of
 * one case number to a single entry, and the surviving prefix must not
 * decide coverage. A slash between the registry letters and the docket
 * number ("8 C/18/2008") folds to the space spelling ("8 C 18/2008") so
 * either form of one docket yields the same key.
 */
export const stripCitePrefix = (value: string): string =>
  value
    .replace(
      /^(?:sp\.\s{0,3}zn\.:?|sen\.\s{0,3}zn\.:?|sygn\.(?:\s{1,3}akt)?|[čc]\.\s{0,3}j\.:?)\s{0,3}/iu,
      "",
    )
    .replaceAll(/\s+/gu, " ")
    .replace(/^(\d{1,4}) ?(\p{L}{1,6}) ?\/ ?(?=\d)/u, "$1 $2 ")
    .toLowerCase()
    .trim();

/** Builds a predicate reporting whether a candidate is covered by any of
 * the extracted citation texts (containment in either direction). */
export const coverageMatcher = (
  extractedTexts: readonly string[],
): ((candidate: string) => boolean) => {
  const extractedKeys = extractedTexts.map(stripCitePrefix);
  return (candidate) => {
    const candidateKey = stripCitePrefix(candidate);
    return extractedKeys.some(
      (have) => candidateKey.includes(have) || have.includes(candidateKey),
    );
  };
};
