/** Plain text above either limit becomes a draft attachment. */
export const PASTED_TEXT_CHIP_MAX_CHARS = 1500;
export const PASTED_TEXT_CHIP_MAX_LINES = 20;

export const shouldChipPaste = (text: string): boolean =>
  text.length > PASTED_TEXT_CHIP_MAX_CHARS ||
  text.split(/\r\n?|\n/u).length > PASTED_TEXT_CHIP_MAX_LINES;
