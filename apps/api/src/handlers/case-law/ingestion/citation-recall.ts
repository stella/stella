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
/**
 * A CELEX number: a sector, the year and a document descriptor, `61997TO0181`
 * or `32017R1001`. No publisher writes a docket this way.
 */
const CELEX_NUMBER = /^\d{5}[A-Z]/u;

/**
 * A case-law CELEX number: sector 6, the year, the court (C the Court of
 * Justice, T the General Court, F the Civil Service Tribunal), the document
 * and the case's ordinal.
 */
const CASE_LAW_CELEX =
  /^6(?<year>\d{4})(?<court>[CTF])[A-Z](?<ordinal>\d{1,4})(?!\d)/u;

/**
 * The Court of Justice prefixed its dockets with `C-` from 1989, when the Court
 * of First Instance opened; before that a docket is a bare `120/78`.
 */
const FIRST_PREFIXED_DOCKET_YEAR = 1989;

/**
 * A publisher's cited entry as extraction would find it in the text, or null
 * where extraction never could.
 *
 * The EU publisher states what a decision cites as CELEX numbers of every
 * sector: treaty articles (`12008E263`), regulations (`32017R1001`) and case
 * law (`61997TO0181`). Extraction finds dockets (`T-181/97`), so a case-law
 * number is compared as its docket and the rest are no citation extraction
 * looks for. A docket from before 1989 is left out too: its bare `120/78`
 * form is one extraction does not take on its own, so counting it would
 * measure a deliberate exclusion. Every other publisher already lists dockets.
 */
const comparableCitation = (cited: string): string | null => {
  if (!CELEX_NUMBER.test(cited)) {
    return cited;
  }
  const { year, court, ordinal } = CASE_LAW_CELEX.exec(cited)?.groups ?? {};
  if (
    year === undefined ||
    court === undefined ||
    ordinal === undefined ||
    Number.parseInt(year, 10) < FIRST_PREFIXED_DOCKET_YEAR
  ) {
    return null;
  }
  return `${court}-${String(Number.parseInt(ordinal, 10))}/${year.slice(2)}`;
};

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
    const trimmed = comparableCitation(cited.trim());
    if (trimmed === null || trimmed.length === 0) {
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
