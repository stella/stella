import {
  corpusFreeTextClause,
  quoteCorpusValue,
} from "@/api/lib/legal-search/corpus-query";
import {
  corpusMorphologyLanguage,
  documentMorphologyLanguage,
} from "@/api/lib/legal-search/morphology/corpus-language";
import { functionWordsFor } from "@/api/lib/legal-search/morphology/function-words";

/** Dates and amounts add noise to coverage ranking; section numbers identify passages. */
const NUMERIC_VALUE =
  /(?<![\p{L}\p{M}\p{N}])\d+(?:[.,/–-]\d+)*(?![\p{L}\p{M}\p{N}])/gu;
const SECTION_DESIGNATION =
  /(?<![\p{L}\p{M}\p{N}])(?:§|odst\.?|p[íi]sm\.?)\s*(\d+[a-z]*|[a-z])(?![\p{L}\p{M}\p{N}])/giu;

type RelaxedLegislationClauseOptions = {
  query: string;
  jurisdiction?: string | undefined;
  language?: string | undefined;
};

export const relaxedLegislationClause = ({
  query,
  jurisdiction,
  language,
}: RelaxedLegislationClauseOptions): string | null => {
  const designations: string[] = [];
  const rest = query
    .normalize("NFC")
    .replace(SECTION_DESIGNATION, (_designation, value: string) => {
      designations.push(value);
      return " ";
    });
  // Quoted designations survive function-word filtering and take the first leaves.
  const text = `${designations.map(quoteCorpusValue).join(" ")} ${rest.replace(NUMERIC_VALUE, " ")}`;
  return corpusFreeTextClause(text, {
    match: "any",
    functionWords: functionWordsFor(
      language === undefined
        ? corpusMorphologyLanguage(jurisdiction)
        : documentMorphologyLanguage(language),
    ),
  });
};
