/**
 * Threshold helpers for the "Pasted N characters" chip.
 *
 * Why a chip and not raw text: long pastes drown the composer
 * (a 5,000-line log fills the visible area and obscures any
 * surrounding instructions the user is writing). AI CLIs like
 * Claude Code and Cursor collapse such pastes into a tappable
 * placeholder, so the user keeps a clean prompt while the model
 * still gets the full content on submit.
 *
 * The full text is preserved on the node attrs and serialized
 * back into HTML on `editor.getHTML()`, so the model is unaware
 * of the visual collapsing.
 */

/**
 * Plain pastes of this many characters or more collapse to a chip.
 * Picked to spare casual pastes (a sentence, a URL, a one-liner of
 * code) while reliably catching long log dumps and copy/pasted
 * documents. Tuned conservatively; revisit if users complain
 * either way.
 */
export const PASTED_TEXT_CHIP_MIN_CHARS = 500;

/**
 * Pastes with at least this many newlines also collapse, even when
 * shorter than `PASTED_TEXT_CHIP_MIN_CHARS`, as long as they exceed
 * `PASTED_TEXT_CHIP_MIN_CHARS_WITH_LINE_BREAKS`. A short multi-line
 * snippet (e.g. a stack trace, a chunk of YAML) hurts composer
 * legibility just as much as a long single-line dump.
 */
export const PASTED_TEXT_CHIP_MIN_LINE_BREAKS = 5;
export const PASTED_TEXT_CHIP_MIN_CHARS_WITH_LINE_BREAKS = 200;

export const shouldChipPaste = (text: string): boolean => {
  if (text.length >= PASTED_TEXT_CHIP_MIN_CHARS) {
    return true;
  }

  const lineBreaks = countLineBreaks(text);
  return (
    lineBreaks >= PASTED_TEXT_CHIP_MIN_LINE_BREAKS &&
    text.length >= PASTED_TEXT_CHIP_MIN_CHARS_WITH_LINE_BREAKS
  );
};

const countLineBreaks = (text: string): number => {
  let count = 0;
  for (const ch of text) {
    if (ch === "\n") {
      count += 1;
    }
  }
  return count;
};
