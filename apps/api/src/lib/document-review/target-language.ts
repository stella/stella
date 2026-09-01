/**
 * The language a review writes its edits in.
 *
 * Resolved once per target document from its whole text, so no finding has
 * to guess from the few blocks it cites. `null` means the document did not
 * resolve to one language (too little text, or a close call such as Czech
 * against Slovak); the language guard then stands down rather than reject
 * edits on a guess.
 */

import type { DocumentTranslationSourceLanguageCode } from "@stll/api-contract/document-translation";

import { detectDocumentTranslationSourceLanguage } from "@/api/lib/document-translation/source-language";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

export type ReviewTargetLanguage = DocumentTranslationSourceLanguageCode | null;

export const resolveReviewTargetLanguage = (
  target: PreparedDocxFile,
): ReviewTargetLanguage => {
  const detection = detectDocumentTranslationSourceLanguage(
    target.blocks.map((block) => block.text).join("\n"),
  );
  return detection.type === "detected" ? detection.language : null;
};

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
  const detection = detectDocumentTranslationSourceLanguage(text);
  return detection.type === "detected" && detection.language !== targetLanguage
    ? detection.language
    : null;
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

/** The language as a prompt names it: "Czech", not "CS". */
export const languageDisplayName = (
  code: DocumentTranslationSourceLanguageCode,
): string => displayNames.of(code) ?? code;
