/**
 * A publisher's own table of contents, printed as plain lines at the top of
 * the text: "Parties / Grounds / Operative part", each line the title of a
 * heading further down. The reader draws its own contents from the headings,
 * so these lines repeat every heading once more before the text starts. They
 * stay in storage (the corpus keeps what the source published) and the reader
 * leaves them out of the view.
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

/**
 * A heading title in the form two copies of it compare equal in: the same
 * letters whatever the case, spacing, Unicode composition or closing
 * punctuation. The reader's contents use it to tell that a model's section and
 * the document's heading name the same part.
 */
export const comparableHeadingTitle = (title: string): string =>
  normalizeUnicode(title, "NFKC")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(TRAILING_TITLE_PUNCTUATION, "")
    .toLocaleLowerCase("und");

/** A block that can be a contents line: one short line of words. */
const contentsLineTitle = (block: Block): string | null => {
  if (block.type !== "paragraph" && block.type !== "heading") {
    return null;
  }
  const text = block.plainText.trim();
  if (
    text.length === 0 ||
    text.length > CONTENTS_LINE_MAX_LENGTH ||
    text.includes("\n")
  ) {
    return null;
  }
  const title = comparableHeadingTitle(text);
  return title.length === 0 ? null : title;
};

/**
 * The blocks of the first leading run that is a table of contents: at least
 * two consecutive short lines, each naming a heading that comes after the
 * run, in the order those headings come. Requiring the order and the later
 * position keeps real text out: a document's own headings never list the
 * headings below them twice in a row. Empty when the document has no such
 * run.
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

  const lastStart = Math.min(blocks.length, CONTENTS_LEADING_BLOCKS);
  for (let start = 0; start < lastStart; start += 1) {
    const run: { blockIndex: number; title: string }[] = [];
    const runLimit = Math.min(blocks.length, start + CONTENTS_MAX_LINES);
    for (let index = start; index < runLimit; index += 1) {
      const block = blocks[index];
      const title = block === undefined ? null : contentsLineTitle(block);
      if (title === null) {
        break;
      }
      run.push({ blockIndex: index, title });
    }
    // The longest prefix of the run whose lines name later headings in order.
    let accepted = 0;
    for (let length = run.length; length >= CONTENTS_MIN_LINES; length -= 1) {
      const lines = run.slice(0, length);
      const runEnd = start + length - 1;
      let previousHeading = runEnd;
      const ordered = lines.every(({ title }) => {
        const heading = headingAfter(title, previousHeading);
        if (heading === -1) {
          return false;
        }
        previousHeading = heading;
        return true;
      });
      if (ordered) {
        accepted = length;
        break;
      }
    }
    if (accepted >= CONTENTS_MIN_LINES) {
      return new Set(
        run
          .slice(0, accepted)
          .flatMap(({ blockIndex }) => blocks[blockIndex]?.id ?? []),
      );
    }
  }
  return new Set();
};
