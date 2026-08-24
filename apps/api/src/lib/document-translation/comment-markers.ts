import type { DocxCommentTranslationUnit } from "./docx-review";

const COMMENT_MARKER_PREFIX = "[[stella-translation:comment-";
const TRANSLATION_CONTROL_MARKER_PATTERN = /\[\[\/?stella-translation:/u;

export const commentTaggedText = (
  comment: DocxCommentTranslationUnit,
): string =>
  `${COMMENT_MARKER_PREFIX}${comment.id}]]${comment.text}[[/stella-translation:comment-${comment.id}]]`;

export const unwrapCommentTranslation = (
  comment: DocxCommentTranslationUnit,
  taggedText: string,
): string | null => {
  const open = `${COMMENT_MARKER_PREFIX}${comment.id}]]`;
  const close = `[[/stella-translation:comment-${comment.id}]]`;
  if (!taggedText.startsWith(open) || !taggedText.endsWith(close)) {
    return null;
  }
  const value = taggedText.slice(open.length, -close.length);
  return TRANSLATION_CONTROL_MARKER_PATTERN.test(value) ? null : value;
};
