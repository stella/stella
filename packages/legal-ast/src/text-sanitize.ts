export const DANGEROUS_CHARS = new RegExp(
  "[" +
    "\x00" +
    "\uFEFF\uFFFE" +
    "\u0000-\u0008" +
    "\u000B\u000C" +
    "\u000E-\u001F" +
    "\u200B-\u200D" +
    "\u2060" +
    "\uFFF9-\uFFFB" +
    "]",
  "gu",
);

export const stripDangerousChars = (value: string): string =>
  value.replace(DANGEROUS_CHARS, "").replace(/\u00A0/gu, " ");
