/**
 * Text as a clipboard comparison sees it: whitespace and line endings are
 * left out, since how a browser serializes a selection across lines, blocks
 * and indentation varies. Nothing else is folded, so a difference in any
 * character, case or punctuation remains.
 */
export const clipboardComparable = (text: string): string =>
  text.replaceAll(/\s+/gu, "");

/**
 * Whether what the reader's own copy put on the clipboard is exactly what a
 * Copy control writes, so the control may confirm it. An empty copy matches
 * nothing.
 */
export const nativeCopyMatches = ({
  copied,
  payload,
}: {
  copied: string;
  payload: string;
}): boolean => {
  const comparable = clipboardComparable(copied);
  return comparable !== "" && comparable === clipboardComparable(payload);
};
