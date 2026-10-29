/**
 * A publisher's own table of contents, printed at the top of the text:
 * "Parties / Grounds / Decision on costs / Operative part", each line the
 * title of a heading further down. The reader draws its own contents from the
 * headings, so these lines repeat every heading once more before the text
 * starts. They stay in storage (the corpus keeps what the source published)
 * and the reader leaves them out of the view.
 *
 * The list arrives in either of two shapes: one block whose lines are the
 * titles (the CJEU's older judgments print it as one paragraph broken into
 * lines), or one short block per title.
 */

import { normalizeUnicode } from "@stll/text-normalize";

import type { Block } from "./document-ast.js";

/** A contents line is a title, not a sentence: anything longer is text. */
const CONTENTS_LINE_MAX_LENGTH = 160;

/** Fewer lines than this are a coincidence, not a table of contents. */
const CONTENTS_MIN_LINES = 2;

/** A contents list longer than this is not one a decision prints. */
const CONTENTS_MAX_LINES = 40;

/**
 * How far into the text a table of contents may start: it leads the text,
 * after at most a title and the parties, never in the middle of it.
 */
const CONTENTS_LEADING_BLOCKS = 80;

const TRAILING_TITLE_PUNCTUATION = /[\s.:;,–—-]+$/u;

/** The dash a publisher sets before a subordinate heading: `– Arguments`. */
const LEADING_TITLE_DASH = /^[–—-]\s+/u;

/**
 * A heading title in the form two copies of it compare equal in: the same
 * letters whatever the case, spacing, Unicode composition, leading dash or
 * closing punctuation. The reader's contents use it to tell that a model's
 * section and the document's heading name the same part.
 */
export const comparableHeadingTitle = (title: string): string =>
  normalizeUnicode(title, "NFKC")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(LEADING_TITLE_DASH, "")
    .replace(TRAILING_TITLE_PUNCTUATION, "")
    .toLocaleLowerCase("und");

/**
 * The titles a block lists when it can be part of a table of contents: each
 * of its lines, when every line is short; null when any line reads as text.
 */
const contentsLineTitles = (block: Block): string[] | null => {
  if (block.type !== "paragraph" && block.type !== "heading") {
    return null;
  }
  const lines = block.plainText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (
    lines.length === 0 ||
    lines.some((line) => line.length > CONTENTS_LINE_MAX_LENGTH)
  ) {
    return null;
  }
  const titles = lines.map(comparableHeadingTitle);
  return titles.some((title) => title.length === 0) ? null : titles;
};

/**
 * The blocks of the first leading run that is a table of contents: at least
 * two short lines (in one block or several consecutive ones), each naming a
 * heading that comes after the run, in the order those headings come.
 * Requiring the order and the later position keeps real text out: a
 * document's own headings never list the headings below them twice in a row.
 * Empty when the document has no such run.
 */
export const leadingSourceContentsBlockIds = (
  blocks: readonly Block[],
): ReadonlySet<string> => {
  const headingIndexesByTitle = new Map<string, number[]>();
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "heading") {
      continue;
    }
    const title = comparableHeadingTitle(block.plainText);
    const indexes = headingIndexesByTitle.get(title);
    if (indexes === undefined) {
      headingIndexesByTitle.set(title, [index]);
    } else {
      indexes.push(index);
    }
  }

  // The first index after `from` at which a heading carries `title`.
  const headingAfter = (title: string, from: number): number =>
    headingIndexesByTitle.get(title)?.find((index) => index > from) ?? -1;

  // Whether `titles`, read after block `runEnd`, name later headings in order.
  const namesLaterHeadings = (titles: readonly string[], runEnd: number) => {
    let previousHeading = runEnd;
    return titles.every((title) => {
      const heading = headingAfter(title, previousHeading);
      if (heading === -1) {
        return false;
      }
      previousHeading = heading;
      return true;
    });
  };

  const lastStart = Math.min(blocks.length, CONTENTS_LEADING_BLOCKS);
  for (let start = 0; start < lastStart; start += 1) {
    const run: { blockIndex: number; titles: string[] }[] = [];
    let lineCount = 0;
    for (let index = start; index < blocks.length; index += 1) {
      const block = blocks[index];
      const titles = block === undefined ? null : contentsLineTitles(block);
      if (titles === null || lineCount + titles.length > CONTENTS_MAX_LINES) {
        break;
      }
      run.push({ blockIndex: index, titles });
      lineCount += titles.length;
    }
    // The longest prefix of the run, in whole blocks, whose lines name later
    // headings in order.
    for (let length = run.length; length >= 1; length -= 1) {
      const accepted = run.slice(0, length);
      const titles = accepted.flatMap((entry) => entry.titles);
      if (
        titles.length >= CONTENTS_MIN_LINES &&
        namesLaterHeadings(titles, start + length - 1)
      ) {
        return new Set(
          accepted.flatMap(({ blockIndex }) => blocks[blockIndex]?.id ?? []),
        );
      }
    }
  }
  return new Set();
};
