import { panic } from "better-result";

/**
 * Printed lines of a typewriter-era text, read back as paragraphs.
 *
 * Decisions from the 1990s reach the publisher as the court's fixed-width
 * typescript: every printed line is its own paragraph, broken at a margin
 * of about 65 characters, justified with doubled spaces, with words split
 * at the margin by a hyphen. Read line by line, a decision of thirteen
 * thousand characters becomes two hundred paragraphs, sentences and dates
 * are cut in half (`ze dne 7.` / `10. 1991 …`), and a line that happens to
 * open with a number or a Roman numeral reads as a heading or a paragraph
 * number.
 *
 * The margin itself is the evidence. A document is hard-wrapped when most
 * of its lines end at one width; a line ending at that width continues on
 * the next one, unless the next line is indented as a new paragraph. Every
 * other line ends where the author ended it, and stays a line. A document
 * whose lines do not share a margin is never reflowed.
 */

/** Where a printed line sits on the page, from its untrimmed text. */
export type PrintedLine = {
  /** Leading spaces: the paragraph indent or a centred line's offset. */
  readonly indent: number;
  /** Characters up to the last visible one, indent included. */
  readonly width: number;
  /** The visible text, trimmed. */
  readonly text: string;
};

/** How a line continues into the next one. */
export const LINE_JOINS = {
  /** The next line opens a new paragraph. */
  BREAK: "break",
  /** The margin broke the line between two words. */
  SPACE: "space",
  /** The margin broke a word, and the hyphen is the break's, not the word's. */
  HYPHEN: "hyphen",
} as const;

export type LineJoin = (typeof LINE_JOINS)[keyof typeof LINE_JOINS];

const HARD_WRAP = {
  /** Fewest printed lines that can show a margin. */
  minLines: 8,
  /** Shortest line counted when looking for the margin. */
  minMarginWidth: 40,
  /** Widest margin a typescript had; wider lines are paragraphs. */
  maxMarginWidth: 100,
  /** Share of the lines that must end at the margin. */
  minShare: 0.5,
  /**
   * A justified line ends at the margin; a ragged one (a bold ruling, a
   * line whose next word was long) up to a short word before it.
   */
  slackBelow: 8,
  /** A line may overrun the margin by a character or two. */
  slackAbove: 2,
  /** An indent at least this deep centres a line: a heading, never prose. */
  centredIndent: 10,
} as const;

export const printedLine = (raw: string): PrintedLine => {
  const visible = raw.replaceAll("\t", " ").trimEnd();
  const text = visible.trimStart();
  return {
    indent: visible.length - text.length,
    width: visible.length,
    text,
  };
};

/**
 * The width most lines of a document end at, when they share one.
 *
 * `null` for a document whose paragraphs are each one line, which is every
 * decision written on a computer: their widths are as varied as their
 * paragraphs.
 */
export const hardWrapMarginOf = (
  lines: readonly PrintedLine[],
): number | null => {
  const printed = lines.filter((line) => line.width > 0);
  if (printed.length < HARD_WRAP.minLines) {
    return null;
  }
  const counts = new Map<number, number>();
  for (const { width } of printed) {
    if (
      width >= HARD_WRAP.minMarginWidth &&
      width <= HARD_WRAP.maxMarginWidth
    ) {
      counts.set(width, (counts.get(width) ?? 0) + 1);
    }
  }
  const margin = [...counts.entries()]
    .toSorted(([leftWidth, left], [rightWidth, right]) =>
      right === left ? rightWidth - leftWidth : right - left,
    )
    .at(0)?.[0];
  if (margin === undefined) {
    return null;
  }
  const atMargin = printed.filter((line) => endsAtMargin(line, margin)).length;
  return atMargin / printed.length >= HARD_WRAP.minShare ? margin : null;
};

const endsAtMargin = (line: PrintedLine, margin: number): boolean =>
  line.width >= margin - HARD_WRAP.slackBelow &&
  line.width <= margin + HARD_WRAP.slackAbove;

/**
 * Where the text of a list item starts on its first line: continuation lines
 * of the item are indented to it, which is not a paragraph's indent.
 */
const ITEM_MARKER_RE =
  /^(?:\d{1,3}[.)]|\p{L}[.)]|\(\d{1,3}\)|\(\p{L}\)|[-–•])[ \t]+/u;

const hangingIndentOf = (line: PrintedLine): number => {
  const marker = ITEM_MARKER_RE.exec(line.text)?.[0];
  return line.indent + (marker?.length ?? 0);
};

/**
 * A line of spaced-out letters ("t a k t o :", "O d ů v o d n ě n í") is
 * display type set on a line of its own, whatever the margin did above it.
 */
const SPACED_DISPLAY_LINE_RE = /^\S(?:\s+\S){3,}$/u;

/**
 * A line indented deeper than the one above it opens a paragraph, unless it
 * is aligned under the text of the list item above it.
 */
const opensParagraph = (above: PrintedLine, line: PrintedLine): boolean =>
  line.indent >= HARD_WRAP.centredIndent ||
  SPACED_DISPLAY_LINE_RE.test(above.text) ||
  SPACED_DISPLAY_LINE_RE.test(line.text) ||
  opensListItem(above, line) ||
  (line.indent > above.indent && line.indent > hangingIndentOf(above));

/**
 * The next item of a list: a marker opening a word, under a line that closed
 * the item before it. A marker before a digit is a date wrapped at the
 * margin (`7.` / `10. 1991`), a dash after an unfinished line is part of a
 * name (`v Praze 5` / `- Stodůlky`), and a letter after a line that ended
 * on one goes on citing points of a provision (`písm. b), c),` / `d) …`).
 */
const LIST_ITEM_OPENING_RE =
  /^(?:\d{1,3}[.)]|\p{L}\)|\(\d{1,3}\)|\(\p{L}\)|[-–•])[ \t]+(?=\p{L})/u;
const CLOSES_ITEM_RE = /[.,;:]$/u;
const CITES_POINT_RE = /(?:^|[\s(])(?:\p{L}|\d{1,3})\)[,;]?$/u;

const opensListItem = (above: PrintedLine, line: PrintedLine): boolean =>
  CLOSES_ITEM_RE.test(above.text) &&
  !CITES_POINT_RE.test(above.text) &&
  LIST_ITEM_OPENING_RE.test(line.text);

/** The sentence goes on: no closing punctuation above, a lowercase word below. */
const continuesSentence = (
  above: PrintedLine,
  line: PrintedLine,
  margin: number,
): boolean =>
  above.indent < HARD_WRAP.centredIndent &&
  above.width >= margin / 2 &&
  !/[.:;!?]$/u.test(above.text) &&
  /^\p{Ll}/u.test(line.text);

/**
 * Words a suspended hyphen stands before: in "dvou- a tříletý" the hyphen is
 * the author's, and a margin after it must not weld "dvoua".
 */
const SUSPENDED_HYPHEN_NEXT_RE = /^(?:a|i|nebo|anebo|či|až|ani)(?=$|[\s,.])/u;

/**
 * How each line continues into the next, for a hard-wrapped document: one
 * join per adjacent pair, `null` lines (anything that is not body text at
 * this position) always breaking.
 */
export const hardWrapJoins = (
  lines: readonly (PrintedLine | null)[],
  margin: number,
): LineJoin[] =>
  lines.slice(0, -1).map((above, index) => {
    const line = lines[index + 1] ?? null;
    if (
      above === null ||
      line === null ||
      above.text === "" ||
      line.text === "" ||
      opensParagraph(above, line) ||
      !(endsAtMargin(above, margin) || continuesSentence(above, line, margin))
    ) {
      return LINE_JOINS.BREAK;
    }
    return /\p{L}-$/u.test(above.text) &&
      /^\p{Ll}/u.test(line.text) &&
      !SUSPENDED_HYPHEN_NEXT_RE.test(line.text)
      ? LINE_JOINS.HYPHEN
      : LINE_JOINS.SPACE;
  });

/**
 * Typewriter residue inside a reflowed paragraph: the doubled spaces a line
 * was justified with, and a hyphen a margin left behind when the text was
 * once rewrapped before it reached the publisher ("Ústavního sou- du").
 * A hyphen before a conjunction is a suspended one, and stays.
 */
export const typescriptText = (text: string): string =>
  text
    .replaceAll(/ {2,}/gu, " ")
    .replaceAll(
      /(?<=\p{L}\p{Ll})- (?!(?:a|i|nebo|anebo|či|až|ani)(?:$|[\s,.]))(?=\p{Ll})/gu,
      "",
    );

/**
 * Plain-text lines (an abstract cell, one `<br>` per printed line) as
 * paragraphs. A text without a margin keeps its lines.
 */
export const reflowPrintedText = (rawLines: readonly string[]): string[] => {
  const lines = rawLines.map(printedLine);
  const margin = hardWrapMarginOf(lines);
  if (margin === null) {
    return lines.map(({ text }) => text);
  }
  const joins = hardWrapJoins(lines, margin);
  const paragraphs: string[] = [];
  let current = lines[0]?.text ?? "";
  for (const [index, join] of joins.entries()) {
    const next = lines[index + 1]?.text ?? "";
    switch (join) {
      case LINE_JOINS.BREAK:
        paragraphs.push(typescriptText(current));
        current = next;
        break;
      case LINE_JOINS.SPACE:
        current = `${current} ${next}`;
        break;
      case LINE_JOINS.HYPHEN:
        current = `${current.slice(0, -1)}${next}`;
        break;
      default: {
        join satisfies never;
        panic("Unhandled line join");
      }
    }
  }
  paragraphs.push(typescriptText(current));
  return paragraphs;
};
