/**
 * The language a review writes its edits in.
 *
 * Resolved once per target document from its whole text, so no finding has
 * to guess from the few blocks it cites. `null` means the document did not
 * resolve to one language (too little text, or a close call such as Czech
 * against Slovak); the language guard then stands down rather than reject
 * edits on a guess.
 */

import { francAll } from "franc";

import {
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
  type DocumentTranslationSourceLanguageCode,
} from "@stll/api-contract/document-translation";

import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

export type ReviewTargetLanguage = DocumentTranslationSourceLanguageCode | null;

const MAX_DETECTION_CHARS = 40_000;
const MIN_LETTERS = 40;
const DETECTED_SCORE_MARGIN = 0.1;
const detectorCodes = DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.map(
  ({ detectorCode }) => detectorCode,
);

/** Best-effort backstop for review edits; translation providers do their own
 * source-language inference and never call this heuristic. */
const detectReviewLanguage = (
  rawText: string,
): DocumentTranslationSourceLanguageCode | null => {
  const text = rawText.slice(0, MAX_DETECTION_CHARS);
  const letterCount = text.match(/\p{L}/gu)?.length ?? 0;
  if (letterCount < MIN_LETTERS) {
    return null;
  }

  const ranked = francAll(text, { only: detectorCodes });
  const first = ranked.at(0);
  if (!first) {
    return null;
  }
  const second = ranked.at(1);
  if (second && first[1] - second[1] < DETECTED_SCORE_MARGIN) {
    return null;
  }
  return (
    DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.find(
      ({ detectorCode }) => detectorCode === first[0],
    )?.code ?? null
  );
};

export const resolveReviewTargetLanguage = (
  target: PreparedDocxFile,
): ReviewTargetLanguage =>
  detectReviewLanguage(target.blocks.map((block) => block.text).join("\n"));

/**
 * The language `text` is confidently written in, when that is not the
 * target's; `null` otherwise. Text too short or too mixed to detect passes:
 * the guard rejects only what it can prove, and the prompt is what keeps a
 * short term in line.
 */
export const foreignLanguageOf = (
  text: string,
  targetLanguage: ReviewTargetLanguage,
): DocumentTranslationSourceLanguageCode | null => {
  if (targetLanguage === null) {
    return null;
  }
  const detected = detectReviewLanguage(text);
  return detected !== null && detected !== targetLanguage ? detected : null;
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

/** The language as a prompt names it: "Czech", not "CS". */
export const languageDisplayName = (
  code: DocumentTranslationSourceLanguageCode,
): string => displayNames.of(code) ?? code;
