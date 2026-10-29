/**
 * The heading of a separate opinion in a Czech decision ("Odlišné stanovisko
 * soudce …", "Odlišná stanoviska …", "Stanovisko menšiny"), shared by the
 * parsers of every court that prints one.
 *
 * The court prints the heading on its own or as the next enumerated item, and
 * names the dissenting judges after it, so the pattern is anchored at the
 * start and bounded by length rather than closed at the end. How long a
 * heading runs is the court's: the caller bounds it.
 */

const SEPARATE_OPINION_HEADING_RE =
  /^(?:Odli[šs]n[ée]\s+stanovisko|Odli[šs]n[áa]\s+stanoviska|Stanovisko\s+men[šs]iny)(?<tail>.*)$/iu;

/**
 * The early plenary of the Constitutional Court set its opinions under a
 * bare, letter-spaced "S T A N O V I S K O" and named the judges on the
 * following lines.
 */
const BARE_OPINION_HEADING_RE = /^STANOVISKO(?<tail>)$/u;

/**
 * What the heading line goes on with: nothing, or whose opinion it is and
 * what it is to. "Odlišné stanovisko odůvodňuji takto:" is a sentence of the
 * opinion, not its heading.
 */
const SEPARATE_OPINION_HEADING_TAIL_RE =
  /^(?:\s*[.:]?$|\s+(?:(?:k|ke)\s+(?:nálezu|usnesení|rozsudku|rozhodnutí|výroku|věci|sp\.|č\.|§|čl\.)|ve\s+věci|podle\s+§|soud|předsed|místopředsed|JUDr|prof|doc|Mgr|pléna|člen|men[šs]in))/iu;

/**
 * What follows the title of a separate opinion's heading on its line, or
 * `undefined` for a line that is no such heading or runs longer than
 * `maxChars`.
 */
export const separateOpinionHeadingTail = (
  plainText: string,
  maxChars: number,
): string | undefined => {
  if (plainText.length > maxChars) {
    return undefined;
  }
  const tail = (
    SEPARATE_OPINION_HEADING_RE.exec(plainText) ??
    BARE_OPINION_HEADING_RE.exec(plainText)
  )?.groups?.["tail"];
  return tail !== undefined && SEPARATE_OPINION_HEADING_TAIL_RE.test(tail)
    ? tail
    : undefined;
};
