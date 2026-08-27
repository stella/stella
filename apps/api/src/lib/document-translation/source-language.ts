import { francAll } from "franc";

import {
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
  type DocumentTranslationSourceLanguageCode,
  type DocumentTranslationSourceLanguageDetection,
} from "@stll/api-contract/document-translation";

const MAX_DETECTION_CHARS = 40_000;
const MIN_LETTERS = 40;
const DETECTED_SCORE_MARGIN = 0.1;
const AMBIGUOUS_SCORE_MARGIN = 0.1;
const HIGH_CONFIDENCE_SCORE_MARGIN = 0.2;
const MAX_AMBIGUOUS_CANDIDATES = 3;

const detectorCodes = DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.map(
  ({ detectorCode }) => detectorCode,
);

/**
 * Detect a source language only within the language contract accepted by the
 * translation API. Short or closely scored samples remain unresolved so the
 * caller can require a deliberate user choice.
 */
export const detectDocumentTranslationSourceLanguage = (
  rawText: string,
): DocumentTranslationSourceLanguageDetection => {
  const text = rawText.slice(0, MAX_DETECTION_CHARS);
  const letterCount = text.match(/\p{L}/gu)?.length ?? 0;
  if (letterCount < MIN_LETTERS) {
    return { type: "unknown" };
  }

  const scores = francAll(text, { only: detectorCodes });
  const ranked: {
    language: DocumentTranslationSourceLanguageCode;
    score: number;
  }[] = [];
  for (const [detectorCode, score] of scores) {
    const language = DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.find(
      (candidate) => candidate.detectorCode === detectorCode,
    );
    if (language) {
      ranked.push({ language: language.code, score });
    }
  }

  const first = ranked.at(0);
  if (!first) {
    return { type: "unknown" };
  }
  const second = ranked.at(1);
  const scoreMargin = second ? first.score - second.score : 1;
  if (scoreMargin >= DETECTED_SCORE_MARGIN) {
    return {
      type: "detected",
      language: first.language,
      confidence:
        scoreMargin >= HIGH_CONFIDENCE_SCORE_MARGIN ? "high" : "medium",
    };
  }

  const candidates = ranked
    .filter(({ score }) => first.score - score <= AMBIGUOUS_SCORE_MARGIN)
    .slice(0, MAX_AMBIGUOUS_CANDIDATES)
    .map(({ language }) => language);
  return candidates.length > 1
    ? { type: "ambiguous", candidates }
    : { type: "unknown" };
};

export const resolveDocumentTranslationSourceLanguage = ({
  declaredLanguage,
  text,
}: {
  declaredLanguage: DocumentTranslationSourceLanguageCode | null;
  text: string;
}): DocumentTranslationSourceLanguageDetection =>
  declaredLanguage === null
    ? detectDocumentTranslationSourceLanguage(text)
    : {
        type: "detected",
        language: declaredLanguage,
        confidence: "high",
      };
