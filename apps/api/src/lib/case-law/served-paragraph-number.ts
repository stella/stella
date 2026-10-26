import { courtParagraphNumber } from "@stll/legal-ast/court-paragraph-number";

/** The sign the served text prints before a court's paragraph number. */
const COURT_PARAGRAPH_SIGN = "¶";

/** A block as the served text reads it. */
export type ServedTextBlock = {
  plainText: string;
  type: string;
  number?: number | undefined;
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
 * figure, in every court's numbering style.
 */
export const servedBlockText = (block: ServedTextBlock): string => {
  const number = courtParagraphNumber(block);
  return number === null
    ? block.plainText
    : `${COURT_PARAGRAPH_SIGN} ${String(number)} ${block.plainText}`;
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
  const printed = match?.groups?.["number"];
  if (match === null || printed === undefined) {
    return null;
  }
  return {
    number: Number.parseInt(printed, 10),
    words: quote.slice(match[0].length),
  };
};
