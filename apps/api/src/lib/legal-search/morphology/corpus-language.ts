import {
  isCaseLawJurisdiction,
  type CaseLawJurisdiction,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  MORPHOLOGY_LANGUAGES,
  type MorphologyLanguage,
} from "@/api/lib/legal-search/morphology/stem";

/**
 * The language a jurisdiction's case-law text is written in, when a stemmer
 * for it exists, or null.
 *
 * One map, because the write side and the read side must agree: the
 * projection stems a decision under this language and the query builder stems
 * the reader's terms under it, so a jurisdiction the two answered differently
 * would index stems nothing ever queries.
 *
 * Total over the declared jurisdictions, so a new corpus has to answer rather
 * than inherit a null. Austria is German and the European index carries 24
 * languages under one jurisdiction, so neither has one language to stem
 * against.
 */
const CORPUS_MORPHOLOGY_LANGUAGE_BY_JURISDICTION = {
  AUT: null,
  CZE: "cs",
  EU: null,
  POL: "pl",
  SVK: "sk",
} as const satisfies Record<CaseLawJurisdiction, MorphologyLanguage | null>;

/**
 * Which language a jurisdiction's text stems against, or null. An unscoped
 * search spans every jurisdiction of a generation, so no one language
 * describes its text and it stems against none.
 */
export const corpusMorphologyLanguage = (
  jurisdiction: string | undefined,
): MorphologyLanguage | null => {
  if (jurisdiction === undefined) {
    return null;
  }
  const canonical = jurisdiction.toUpperCase();
  return isCaseLawJurisdiction(canonical)
    ? CORPUS_MORPHOLOGY_LANGUAGE_BY_JURISDICTION[canonical]
    : null;
};

/**
 * A document's own ISO 639-1 language as a language this module can stem, or
 * null. The projection reads the decision's language rather than its
 * jurisdiction: an index group spans several countries, and a court may
 * publish in more than one language.
 */
export const documentMorphologyLanguage = (
  language: string,
): MorphologyLanguage | null =>
  MORPHOLOGY_LANGUAGES.find(
    (candidate) => candidate === language.toLowerCase(),
  ) ?? null;
