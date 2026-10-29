import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { courtParagraphNumber } from "@stll/legal-ast/court-paragraph-number";

/** The sign the served text prints before a court's paragraph number. */
const COURT_PARAGRAPH_SIGN = "¶";

/** A block as the served text reads it. */
export type ServedTextBlock = {
  plainText: string;
  type: string;
  number?: number | undefined;
  note?: { label: string; noteId?: string | undefined } | undefined;
};

/** Whether `text` opens with `mark` as a whole token (`3 Zob.`, not `30 lat`). */
const opensWith = (text: string, mark: string): boolean =>
  text.startsWith(mark) && !/^[\p{L}\p{N}]/u.test(text.slice(mark.length));

/**
 * The mark the served text prints before a footnote block, or null.
 *
 * Parsers keep a footnote's printed mark (`[3]`, `3`, `*`) as structure
 * (`note.label`), so text read without that structure would list the notes
 * without the marks the body points to them with. A note that spans several
 * adjacent blocks repeats one `noteId`; its mark opens the first only, as the
 * reader shows it. A block whose text already opens with the mark keeps it
 * once.
 */
export const servedNoteLabel = (
  block: ServedTextBlock,
  previous: ServedTextBlock | undefined,
): string | null => {
  const label = block.note?.label.trim() ?? "";
  if (label === "" || opensWith(block.plainText, label)) {
    return null;
  }
  const noteId = block.note?.noteId;
  return noteId !== undefined && previous?.note?.noteId === noteId
    ? null
    : label;
};

/**
 * One block as the served text prints it: a paragraph the court numbered
 * opens with that number (`¶ 134 It follows…`).
 *
 * Parsers keep the court's number as structure (`ParagraphBlock.number`)
 * rather than in `plainText`, so that a search for the paragraph's words
 * does not also find its number. Text read without the structure beside it
 * would then carry no number at all, and a paragraph could be quoted but
 * not cited. `¶` keeps the number apart from text that itself opens with a
 * figure, in every court's numbering style. A footnote block opens with
 * its printed mark (`servedNoteLabel`); `previous` is the block before it in
 * the document, which tells a note's continuation from its first block.
 */
export const servedBlockText = (
  block: ServedTextBlock,
  previous?: ServedTextBlock,
): string => {
  const number = courtParagraphNumber(block);
  const noteLabel = servedNoteLabel(block, previous);
  return [
    ...(number === null ? [] : [`${COURT_PARAGRAPH_SIGN} ${String(number)}`]),
    ...(noteLabel === null ? [] : [noteLabel]),
    block.plainText,
  ].join(" ");
};

const SERVED_PARAGRAPH_PREFIX = new RegExp(
  String.raw`^\s*${COURT_PARAGRAPH_SIGN}\s*(?<number>\d{1,9})\s+`,
  "u",
);

/**
 * A quote copied from the served text together with the number
 * `servedBlockText` printed in front of its paragraph (`¶ 134 It follows`):
 * the paragraph's number and the words the paragraph itself holds. Null
 * when the quote does not open that way.
 */
export const servedParagraphQuoteOf = (
  quote: string,
): { number: number; words: string } | null => {
  const match = SERVED_PARAGRAPH_PREFIX.exec(quote);
  const number = parseIntegerToken(match?.groups?.["number"], {
    sign: "unsigned",
  });
  if (match === null || Result.isError(number)) {
    return null;
  }
  return { number: number.value, words: quote.slice(match[0].length) };
};
