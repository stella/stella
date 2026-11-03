/**
 * The quotation pairs of Czech and Slovak text: „…“ (often printed „…”) and
 * »…« or «…». Each pair closes only with its own mark; a straight quote closes
 * neither, and the English “…” never opens one here.
 */
const QUOTE_PAIRS = [
  { opening: "„", closing: new Set(["“", "”"]) },
  { opening: "»", closing: new Set(["«"]) },
  { opening: "«", closing: new Set(["»"]) },
] as const;

/**
 * Most paragraphs a quotation may run on past the one that opens it. A
 * longer one, or one never closed by its own mark, is not evidence enough
 * to set a marker apart from the court's numbering.
 */
const MAX_QUOTED_PARAGRAPHS = 8;

/**
 * Body positions that open inside a quotation an earlier paragraph began
 * and a later one, at most {@link MAX_QUOTED_PARAGRAPHS} on, closes with
 * the matching mark. A quotation never crosses a heading or the start of a
 * separate opinion.
 */
export const closedQuotationParagraphStarts = (
  texts: readonly string[],
  sectionStarts: ReadonlySet<number>,
): Set<number> => {
  const quoted = new Set<number>();
  const open: { start: number; closing: ReadonlySet<string> }[] = [];
  for (const [bodyIndex, text] of texts.entries()) {
    if (sectionStarts.has(bodyIndex)) {
      open.length = 0;
    }
    for (let index = open.length - 1; index >= 0; index--) {
      const quotation = open[index];
      if (
        quotation !== undefined &&
        bodyIndex - quotation.start > MAX_QUOTED_PARAGRAPHS
      ) {
        open.splice(index, 1);
      }
    }
    for (const character of text) {
      const closing = open.findLastIndex((quotation) =>
        quotation.closing.has(character),
      );
      const quotation = open[closing];
      if (quotation !== undefined) {
        // Closing an enclosing quotation also ends any unmatched inner opener.
        open.splice(closing);
        for (let inside = quotation.start + 1; inside <= bodyIndex; inside++) {
          quoted.add(inside);
        }
        continue;
      }
      const pair = QUOTE_PAIRS.find(({ opening }) => opening === character);
      if (pair !== undefined) {
        open.push({ start: bodyIndex, closing: pair.closing });
      }
    }
  }
  return quoted;
};
