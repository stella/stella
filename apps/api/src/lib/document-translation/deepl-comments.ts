import { Result } from "better-result";

import type { DocxCommentTranslationUnit } from "@/api/lib/document-translation/docx-review";

export const mapDeepLCommentTranslations = (
  comments: readonly DocxCommentTranslationUnit[],
  translatedTexts: readonly string[],
): Result<Map<number, string>, "translation_failed"> => {
  const translated = new Map<number, string>();
  const pending: DocxCommentTranslationUnit[] = [];
  for (const comment of comments) {
    if (comment.text === "") {
      translated.set(comment.id, "");
      continue;
    }
    pending.push(comment);
  }
  if (translatedTexts.length !== pending.length) {
    return Result.err("translation_failed");
  }
  for (const [index, comment] of pending.entries()) {
    const text = translatedTexts.at(index);
    if (text === undefined) {
      return Result.err("translation_failed");
    }
    translated.set(comment.id, text);
  }
  return Result.ok(translated);
};
