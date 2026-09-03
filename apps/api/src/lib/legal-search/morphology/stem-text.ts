import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import {
  stemLegalTerm,
  type MorphologyLanguage,
} from "@/api/lib/legal-search/morphology/stem";

/**
 * A run of text as the stems of its tokens, in order, separated by single
 * spaces.
 *
 * The separator is not cosmetic. The field this feeds is tokenised by the
 * engine exactly like the surface field, so one stem per token joined by one
 * space gives a stem stream whose positions correspond one to one with the
 * surface stream's: the reader's phrase, stemmed the same way, matches
 * adjacently or not at all. Dropping a token, or emitting two words for one,
 * would shift every position after it and turn a phrase into a near-miss.
 *
 * The input must be the accented corpus text, never a folded copy: the suffix
 * tables are written over accented characters, so a folded token keeps the
 * ending the stemmer exists to strip. Folding happens afterwards, inside the
 * engine, because the field's tokenizer applies `ascii_folding` to what is
 * written here and to the query alike.
 */
export const stemCorpusText = (
  text: string,
  language: MorphologyLanguage,
): string => {
  const stems: string[] = [];
  for (const token of corpusTokens(text)) {
    stems.push(stemLegalTerm(token, language));
  }
  return stems.join(" ");
};
