/**
 * Text a user supplies that ends up inside the signed PDF (reason,
 * location, the stamp's labels) is capped and stripped of control
 * characters, including the line breaks that would let a value spill
 * across dictionary entries or stamp lines.
 */

const C0_END = 0x1f;
const C1_START = 0x7f;
const C1_END = 0x9f;

/**
 * Replace C0 and C1 control characters with a space. Segmenter-based
 * iteration keeps a grapheme cluster (an emoji with a modifier, a combining
 * accent) whole: only the control ranges are rewritten, everything else is
 * copied through untouched.
 */
export const stripControlCharacters = (value: string) => {
  const segmenter = new Intl.Segmenter();
  let sanitized = "";
  for (const { segment } of segmenter.segment(value)) {
    const codePoint = segment.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= C0_END || (codePoint >= C1_START && codePoint <= C1_END);
    sanitized += isControl ? " " : segment;
  }
  return sanitized;
};

/** Sanitized and capped; `null` when nothing is left. */
export const sanitizeSigningText = (
  value: string | undefined,
  maxLength: number,
) => {
  if (value === undefined) {
    return null;
  }
  const sanitized = stripControlCharacters(value).trim().slice(0, maxLength);
  return sanitized === "" ? null : sanitized;
};
