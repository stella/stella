/**
 * Hungarian "ő" and "ű" as the writer typed them.
 *
 * Neither letter is in Latin-1 or windows-1252, and a tool working in either
 * wrote the nearest letter it had: "õ" for "ő", "û" for "ű". Neither "õ" nor
 * "û" is a Hungarian letter, so in Hungarian text each one is the
 * double-acute letter it stands in for.
 *
 * Text decoded through the code page it was written in reads right without
 * this (byte F5 is "ő" in windows-1250). What a decoder cannot see is text
 * that carries the stand-in itself, as an RTF `\u245` escape or as a
 * character of a Word package. One fold, so every reader of a Hungarian
 * source, and every check of what that reader kept, reads the same letters.
 */

const HUNGARIAN_LETTERS = new Map([
  ["õ", "ő"],
  ["Õ", "Ő"],
  ["û", "ű"],
  ["Û", "Ű"],
]);

const STAND_INS = /[õÕûÛ]/gu;

/** `text` with every Latin-1 stand-in for "ő" and "ű" read as the letter. */
export const restoreHungarianLetters = (text: string): string =>
  text.replaceAll(
    STAND_INS,
    (letter) => HUNGARIAN_LETTERS.get(letter) ?? letter,
  );
