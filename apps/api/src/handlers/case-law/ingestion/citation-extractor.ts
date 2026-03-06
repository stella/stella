/**
 * Extracted citation reference found in decision text.
 */
export type ExtractedCitation = {
  /** The raw citation text as found in the source. */
  citationText: string;
  /** Section index where the citation was found. */
  sectionIndex: number | null;
};

/**
 * Patterns for recognizing case law citations in Czech and
 * Slovak court decision texts. Covers common reference formats
 * used in judicial practice.
 *
 * Based on analysis of 770K citation instances in the CzCDC
 * corpus (Harasta, Masaryk University).
 */
const CITATION_PATTERNS: RegExp[] = [
  // Czech case number: "sp. zn. 21 Cdo 1234/2020"
  /sp\.\s*zn\.\s*(\d{1,3}\s+[A-Za-z]{1,5}\s+\d{1,6}\/\d{4})/g,

  // ECLI: "ECLI:CZ:NS:2020:21.CDO.1234.2020.1"
  /ECLI:[A-Z]{2}:[A-Z]{1,8}:\d{4}:[\w.]+/g,

  // Czech collection: "č. 123/2020 Sb. rozh. tr."
  /[čc]\.\s*\d{1,5}\/\d{4}\s+Sb\.\s*(?:rozh\.\s*(?:tr|ob)\.?|NS)/g,

  // Slovak case number: "sp. zn. 1Cdo/123/2020"
  /sp\.\s*zn\.\s*\d{1,3}[A-Za-z]{1,5}\/\d{1,6}\/\d{4}/g,

  // Generic: "rozsudek č.j. 5 As 123/2020"
  /[čc]\.\s*j\.\s*\d{1,3}\s+[A-Za-z]{1,5}\s+\d{1,6}\/\d{4}/g,
];

/**
 * Extract citation references from decision text.
 *
 * Scans each section of the decision for patterns matching
 * known citation formats. Returns deduplicated citations with
 * their source section index.
 */
export const extractCitations = (
  sections: Array<{ index: number; text: string }>,
): ExtractedCitation[] => {
  const seen = new Set<string>();
  const citations: ExtractedCitation[] = [];

  for (const section of sections) {
    for (const pattern of CITATION_PATTERNS) {
      pattern.lastIndex = 0;

      for (
        let match = pattern.exec(section.text);
        match !== null;
        match = pattern.exec(section.text)
      ) {
        const citationText = match[0].trim();

        if (seen.has(citationText)) {
          continue;
        }
        seen.add(citationText);

        citations.push({
          citationText,
          sectionIndex: section.index,
        });
      }
    }
  }

  return citations;
};
