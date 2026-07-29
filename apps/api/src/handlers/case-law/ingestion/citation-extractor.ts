/**
 * Extracted citation reference found in decision text.
 */
type ExtractedCitation = {
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
// Polish prefixed pattern: "sygn. akt II CSK 123/20".
// Group 1 captures the bare case number to deduplicate
// against the unprefixed pattern below.
const PL_PREFIXED_PATTERN =
  /sygn\.\s*(?:akt\s+)?(?<caseNumber>[IVX]{1,4}\s+[A-Za-z]{1,5}\s+\d{1,6}\/\d{2,4})/gu;

const CITATION_PATTERNS: RegExp[] = [
  // Czech case number: "sp. zn. 21 Cdo 1234/2020". Two-digit years
  // ("2 Cdon 808/97") are the standard form for pre-2000 decisions, and
  // registry codes can carry diacritics, so the registry is a letter run
  // and the year is 2 to 4 digits; the resolver owns century mapping.
  /sp\.\s*zn\.\s*(?<caseNumber>\d{1,3}\s+\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Czech senate file number: "sen. zn. 29 NSČR 55/2013" (grand panel,
  // insolvency). Same shape as sp. zn. under a different prefix.
  /sen\.\s*zn\.\s*(?<caseNumber>\d{1,3}\s+\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Czech letter-first registries without a senate number:
  // "sp. zn. Nt 408/2023" (criminal auxiliary), "sp. zn. A 9/2003"
  // (pre-2003 administrative). The registry run is short and must be
  // followed by a space and digits, which keeps agency file numbers
  // ("MSP-725/2022") out.
  /sp\.\s*zn\.\s*(?<caseNumber>\p{L}{1,4}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Czech Constitutional Court: "IV. ÚS 23/05", "Pl. ÚS 12/94" — the
  // senate is a Roman numeral (or Pl. for the plenum), so the digit-led
  // pattern above never matches these. The bare form also covers the
  // "sp. zn. IV. ÚS 23/05" spelling.
  /\b(?<caseNumber>(?:[IVX]{1,4}|Pl)\.\s*ÚS\s+\d{1,5}\/\d{2,4})(?!\d)/gu,

  // CJEU: "C-283/81", "T-13/99", "F-100/09" (Court of Justice, General
  // Court, Civil Service Tribunal), including the non-breaking hyphen
  // the publications office uses ("C‑283/81").
  /\b(?<caseNumber>[CTF][-‑]\d{1,4}\/\d{2})(?!\d)/gu,

  // ECLI: "ECLI:CZ:NS:2020:21.CDO.1234.2020.1"
  /ECLI:[A-Z]{2}:[A-Z]{1,8}:\d{4}:[\w.]+/gu,

  // Czech collection: "č. 123/2020 Sb. rozh. tr."
  /[čc]\.\s*\d{1,5}\/\d{4}\s+Sb\.\s*(?:rozh\.\s*(?:tr|ob)\.?|NS)/gu,

  // Slovak case number: "sp. zn. 1Cdo/123/2020"
  /sp\.\s*zn\.\s*\d{1,3}[A-Za-z]{1,5}\/\d{1,6}\/\d{4}/gu,

  // Generic: "rozsudek č.j. 5 As 123/2020"; registrars also write
  // "č. j.: 137 Ex 1850/23".
  /[čc]\.\s*j\.:?\s*(?<caseNumber>\d{1,3}\s+\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  PL_PREFIXED_PATTERN,

  // Polish case number without prefix: "II CSK 123/20", "II ACa 45/20".
  // The division code is an uppercase chamber code (CSK, KK, CSKP) or an
  // uppercase code with an appellate suffix (ACa, ACz, AKa). Requiring that
  // shape stops ordinary mixed-case prose like "Article XV See 12/20" from
  // being captured as a phantom citation.
  /\b[IVX]{2,4}\s+(?:[A-Z]{2,5}|[A-Z]{1,4}[az])\s+\d{1,6}\/\d{2,4}\b/gu,
];

/**
 * The publications office typesets CJEU numbers with U+2011; the
 * corpus stores the ASCII form. Comparisons and dedup keys must not
 * treat the two spellings as different citations.
 */
const normalizeDashes = (text: string): string => text.replace(/[‑–]/gu, "-");

/** Strip known prefixes to get the bare case number. */
const stripPrefix = (text: string): string => {
  const trimmed = text.trim();

  // Czech: "sp. zn. 21 Cdo 1234/2020"
  const spZn = /^sp\.\s*zn\.\s*(?<caseNumber>.+)/iu.exec(trimmed);
  if (spZn?.groups?.["caseNumber"]) {
    return spZn.groups["caseNumber"].trim();
  }

  // Czech: "č. j. 5 As 123/2020", "č.j. 5 As 123/2020", "č. j.: 5 As 123/2020"
  const cj = /^[čc]\.\s*j\.:?\s*(?<caseNumber>.+)/iu.exec(trimmed);
  if (cj?.groups?.["caseNumber"]) {
    return cj.groups["caseNumber"].trim();
  }

  // Czech senate file number: "sen. zn. 29 NSČR 55/2013"
  const senZn = /^sen\.\s*zn\.\s*(?<caseNumber>.+)/iu.exec(trimmed);
  if (senZn?.groups?.["caseNumber"]) {
    return senZn.groups["caseNumber"].trim();
  }

  // Polish: "sygn. akt II CSK 123/20"
  const sygn = /^sygn\.\s*(?:akt\s+)?(?<caseNumber>.+)/iu.exec(trimmed);
  if (sygn?.groups?.["caseNumber"]) {
    return sygn.groups["caseNumber"].trim();
  }

  return trimmed;
};

/**
 * Canonical comparison key for a citation or case number: prefix
 * stripped, typographic dashes normalized, case-folded. Two spellings
 * of the same case number share one key.
 */
export const bareCitationKey = (text: string): string =>
  normalizeDashes(stripPrefix(text.trim()))
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    // After whitespace collapses, slash spacing is at most one space per
    // side; plain string replaces keep the scan linear.
    .replaceAll(" /", "/")
    .replaceAll("/ ", "/")
    .trim();

type DecisionIdentity = {
  caseNumber: string;
  ecli?: string | null;
};

/**
 * Check whether a citation text refers to the same decision
 * that contains it (self-citation).
 */
export const isSelfCitation = (
  citationText: string,
  decision: DecisionIdentity,
): boolean => {
  const trimmed = citationText.trim();

  // ECLI exact match
  if (decision.ecli && trimmed === decision.ecli) {
    return true;
  }

  // Compare bare case numbers (case-insensitive)
  return bareCitationKey(trimmed) === bareCitationKey(decision.caseNumber);
};

/**
 * Extract citation references from decision text.
 *
 * Scans each section of the decision for patterns matching
 * known citation formats. Returns deduplicated citations with
 * their source section index.
 */
export const extractCitations = (
  sections: { index: number; text: string }[],
): ExtractedCitation[] => {
  const byKey = new Map<string, ExtractedCitation>();

  for (const section of sections) {
    for (const pattern of CITATION_PATTERNS) {
      pattern.lastIndex = 0;

      for (
        let match = pattern.exec(section.text);
        match !== null;
        match = pattern.exec(section.text)
      ) {
        const citationText = match[0].trim();
        // For patterns with a capture group (e.g. the Polish
        // prefixed pattern), use the bare case number as the
        // canonical dedup key so both "sygn. akt II CSK 123/20"
        // and "II CSK 123/20" resolve to the same key regardless
        // of which fires first.
        const dedupKey = normalizeDashes(
          match.groups?.["caseNumber"]?.trim() ?? citationText,
        );

        const existing = byKey.get(dedupKey);
        if (!existing) {
          byKey.set(dedupKey, { citationText, sectionIndex: section.index });
          continue;
        }
        // Prefer a later occurrence over an earlier one: a case is often
        // listed bare in the header (low section index) and then discussed
        // in the reasoning. The discussion carries the polarity signal, so
        // record the later section's context, not the header's.
        if (
          existing.sectionIndex === null ||
          section.index > existing.sectionIndex
        ) {
          existing.citationText = citationText;
          existing.sectionIndex = section.index;
        }
      }
    }
  }

  return [...byKey.values()];
};
