import { normalizeUnicode } from "@stll/text-normalize";

import {
  corpusFreeTextClause,
  quoteCorpusValue,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import {
  corpusMorphologyLanguage,
  documentMorphologyLanguage,
} from "@/api/lib/legal-search/morphology/corpus-language";
import {
  functionWordKey,
  functionWordsFor,
} from "@/api/lib/legal-search/morphology/function-words";

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
  const rest = normalizeUnicode(query, "NFC").replace(
    SECTION_DESIGNATION,
    (_designation, value: string) => {
      designations.push(value);
      return " ";
    },
  );
  // Quoted designations survive function-word filtering and take the first leaves.
  const text = `${designations.map(quoteCorpusValue).join(" ")} ${rest.replace(NUMERIC_VALUE, " ")}`;
  const functionWords = functionWordsFor(
    language === undefined
      ? corpusMorphologyLanguage(jurisdiction)
      : documentMorphologyLanguage(language),
  );
  // Strict searches retain an all-function-word query; relaxing it would
  // OR unrelated passages without a content word to anchor coverage.
  if (
    functionWords !== null &&
    tokenizeCorpusFreeText(text).every(
      (token) =>
        token.type === "term" &&
        functionWords.has(functionWordKey(token.value)),
    )
  ) {
    return null;
  }
  return corpusFreeTextClause(text, { match: "any", functionWords });
};
