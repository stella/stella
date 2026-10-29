// parser-output-unchanged: Existing typescript reflow is unchanged; the new PDF join reader is used only by sk-courts.
import { panic } from "better-result";

import {
  classifyLineWrap,
  LINE_JOIN,
  LINE_WRAP_TYPE,
  lineJoinOf,
  PRENOMINAL_TITLE_END_RE,
} from "@stll/legal-ast/line-wrap";
import { normalizeUnicode } from "@stll/text-normalize";

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
 * Paragraphs are rebuilt here, at ingestion: a parser stores real
 * paragraphs, and the raw payload stays the verbatim published record.
 * Whether a text is fixed-width wrapped at all, and at which column, is
 * decided by the one shared classifier (`classifyLineWrap` in
 * `@stll/legal-ast/line-wrap`): most lines end near one column, and many
 * line boundaries fall inside a sentence. Short paragraphs of similar
 * length share a width too, but each ends its sentence. This module owns
 * what a typescript's line ends mean: which continue a paragraph, which
 * hyphen a margin added, and what residue the typewriter left.
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
  /** The margin broke a word: the hyphen is the break's and goes. */
  WORD: "word",
  /** The margin fell after the hyphen of a compound, which stays. */
  COMPOUND: "compound",
} as const;

type PrintedLineJoin = (typeof LINE_JOINS)[keyof typeof LINE_JOINS];

/** A join that continues the paragraph. */
export type ContinuingJoin = Exclude<PrintedLineJoin, typeof LINE_JOINS.BREAK>;

const HARD_WRAP = {
  /**
   * A justified line ends at the margin; a ragged one (a bold ruling, a
   * line whose next word was long) up to a short word before it.
   */
  slackBelow: 8,
  /** A line may overrun the margin by a character or two. */
  slackAbove: 2,
  /**
   * A line this close to the margin was filled to it: a document typed on
   * two machines has two margins a character or two apart.
   */
  filledSlack: 2,
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

/** What a typescript's line ends are, once a text is known to be one. */
export type HardWrapReading = {
  /** The width the typescript's lines end at. */
  readonly margin: number;
  /** How each line continues into the next: one join per adjacent pair. */
  readonly joins: readonly PrintedLineJoin[];
  /**
   * Typewriter residue removed from the text of a reflowed paragraph: the
   * doubled spaces lines were justified with, and a hyphen a margin left
   * inside a line when the text was rewrapped before it reached the
   * publisher ("Ústavního sou- du"), where the text itself spells the word
   * whole elsewhere.
   */
  readonly clean: (text: string) => string;
};

/**
 * A sentence ends here: a full stop, a question, an exclamation, a colon.
 * Not after an initial ("proti žalovanému P." / "F. (dále jen …").
 */
const SENTENCE_END_RE = /(?<!(?:^|[\s(])\p{Lu})[.!?:]["'“”’)]*$/u;
const OPENS_SENTENCE_RE = /^["'„“(]*\p{Lu}/u;
const SOFT_HYPHEN = "\u00ad";
const LETTER_RE = /\p{L}/u;

/** Where the run of letters ending just before `end` starts. */
const lettersStartBefore = (text: string, end: number): number => {
  let start = end;
  while (start > 0 && LETTER_RE.test(text.charAt(start - 1))) {
    start -= 1;
  }
  return start;
};

/** Where the run of letters starting at `start` ends. */
const lettersEndAfter = (text: string, start: number): number => {
  let end = start;
  while (end < text.length && LETTER_RE.test(text.charAt(end))) {
    end += 1;
  }
  return end;
};

type LineEndHyphen = { readonly stem: string; readonly soft: boolean };

/**
 * A line ending in a hyphen the margin may have put there, after a word.
 * Read by scanning back from the end, so a long line costs its length once.
 */
const lineEndHyphenOf = (text: string): LineEndHyphen | null => {
  const mark = text.at(-1);
  if (mark !== "-" && mark !== SOFT_HYPHEN) {
    return null;
  }
  const end = text.length - 1;
  const stem = text.slice(lettersStartBefore(text, end), end);
  return stem === "" ? null : { stem, soft: mark === SOFT_HYPHEN };
};
/** The typewriter stretched the line: words apart by more than a space. */
const JUSTIFIED_RE = /\S {2,}\S/u;

const endsAtMargin = (line: PrintedLine, margin: number): boolean =>
  line.width >= margin - HARD_WRAP.slackBelow &&
  line.width <= margin + HARD_WRAP.slackAbove;

/**
 * The column a typescript's lines end at, or `null` for a text that is not
 * one. Whether a text is fixed-width wrapped is decided by the one shared
 * classifier, which the reader's display of unreparsed rows uses too.
 */
const hardWrapMarginOf = (
  lines: readonly (PrintedLine | null)[],
): number | null => {
  const classification = classifyLineWrap(
    lines.map((line) =>
      line === null ? null : `${" ".repeat(line.indent)}${line.text}`,
    ),
  );
  return classification.type === LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED
    ? classification.width
    : null;
};

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

/**
 * A sentence ending at a line end ends the paragraph when the next line
 * opens a new sentence, unless the line is filled to the margin: the
 * typewriter filled every line of a paragraph but its last, stretching it
 * with doubled spaces where the words fell short. A colon is read the same
 * way: short, it closes a lead-in ("… takto:" / the ruling); filled, it
 * goes on into a citation or a quotation ("Ústavní soud ČR:" / "Sbírka
 * nálezů …"). A line going on in lowercase or with a digit continues an
 * abbreviation or a date (`sp. zn.` / `18 Co 140/2000`, `ze dne 7.` /
 * `10. 1991`).
 */
const endsParagraph = (
  above: PrintedLine,
  line: PrintedLine,
  margin: number,
): boolean =>
  SENTENCE_END_RE.test(above.text) &&
  OPENS_SENTENCE_RE.test(line.text) &&
  above.width < margin - HARD_WRAP.filledSlack &&
  !JUSTIFIED_RE.test(above.text);

/**
 * A line indented deeper than the one above it opens a paragraph, unless it
 * is aligned under the text of the list item above it.
 */
const opensParagraph = (
  above: PrintedLine,
  line: PrintedLine,
  margin: number,
): boolean =>
  line.indent >= HARD_WRAP.centredIndent ||
  SPACED_DISPLAY_LINE_RE.test(above.text) ||
  SPACED_DISPLAY_LINE_RE.test(line.text) ||
  opensListItem(above, line) ||
  endsParagraph(above, line, margin) ||
  (line.indent > above.indent && line.indent > hangingIndentOf(above));

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
const SUSPENDED_HYPHEN_NEXT = new Set([
  "a",
  "i",
  "nebo",
  "anebo",
  "či",
  "až",
  "ani",
]);
/**
 * The words a text spells, to tell a word the margin split ("dis-" /
 * "kriminaci", with "diskriminaci" spelled whole elsewhere) from a compound
 * whose hyphen is the author's ("česko-" / "slovenský"). Only the whole
 * word counts as evidence: "Československo" elsewhere does not make
 * "česko-" / "slovenský" one word. Without that evidence a hyphen is kept:
 * a compound read as one word changes the word, a split word read with its
 * hyphen does not.
 */
type Vocabulary = {
  /** Every whole word, lowercased and NFC-normalised. */
  readonly words: ReadonlySet<string>;
  /** Hyphenated compounds the text spells within a line, likewise. */
  readonly compounds: ReadonlySet<string>;
};

const wordKey = (word: string): string =>
  normalizeUnicode(word, "NFC").toLowerCase();

const vocabularyOf = (texts: readonly string[]): Vocabulary => {
  const words = new Set<string>();
  const compounds = new Set<string>();
  for (const text of texts) {
    const normalized = normalizeUnicode(text, "NFC");
    let previous: { word: string; end: number } | null = null;
    for (const match of normalized.matchAll(/\p{L}+/gu)) {
      const [word] = match;
      words.add(wordKey(word));
      // Two words joined by a single hyphen and nothing else are a compound.
      if (
        previous !== null &&
        match.index === previous.end + 1 &&
        normalized.charAt(previous.end) === "-"
      ) {
        compounds.add(wordKey(`${previous.word}-${word}`));
      }
      previous = { word, end: match.index + word.length };
    }
  }
  return { words, compounds };
};

/** How the halves of a hyphenated word read: welded, or as a compound. */
const hyphenatedJoin = (
  vocabulary: Vocabulary,
  stem: string,
  next: string,
): PrintedLineJoin => {
  const rest = /^\p{L}+/u.exec(normalizeUnicode(next, "NFC"))?.[0] ?? "";
  if (SUSPENDED_HYPHEN_NEXT.has(rest)) {
    return LINE_JOINS.SPACE;
  }
  if (vocabulary.compounds.has(wordKey(`${stem}-${rest}`))) {
    return LINE_JOINS.COMPOUND;
  }
  return vocabulary.words.has(wordKey(`${stem}${rest}`))
    ? LINE_JOINS.WORD
    : LINE_JOINS.COMPOUND;
};

const joinOf = (
  above: PrintedLine | null,
  line: PrintedLine | null,
  margin: number,
  vocabulary: Vocabulary,
): PrintedLineJoin => {
  if (
    above === null ||
    line === null ||
    above.text === "" ||
    line.text === "" ||
    opensParagraph(above, line, margin) ||
    !(endsAtMargin(above, margin) || continuesSentence(above, line, margin))
  ) {
    return LINE_JOINS.BREAK;
  }
  const hyphen = lineEndHyphenOf(above.text);
  if (hyphen === null || !/^\p{Ll}/u.test(line.text)) {
    return LINE_JOINS.SPACE;
  }
  return hyphen.soft
    ? LINE_JOINS.WORD
    : hyphenatedJoin(vocabulary, hyphen.stem, line.text);
};

const STRANDED_HYPHEN = "- ";
const STEM_MIN_LETTERS = 2;

/**
 * Join "sou- du" where the text spells "soudu" whole: each "- " is read
 * once, with the letters on either side of it.
 */
const joinStrandedHyphens = (vocabulary: Vocabulary, text: string): string => {
  const parts: string[] = [];
  let copied = 0;
  let at = text.indexOf(STRANDED_HYPHEN);
  while (at !== -1) {
    const stemStart = lettersStartBefore(text, at);
    const restStart = at + STRANDED_HYPHEN.length;
    const restEnd = lettersEndAfter(text, restStart);
    const stem = text.slice(stemStart, at);
    const rest = text.slice(restStart, restEnd);
    if (
      stem.length >= STEM_MIN_LETTERS &&
      /^\p{Ll}/u.test(rest) &&
      hyphenatedJoin(vocabulary, stem, rest) === LINE_JOINS.WORD
    ) {
      parts.push(text.slice(copied, at));
      copied = restStart;
    }
    at = text.indexOf(STRANDED_HYPHEN, restStart);
  }
  parts.push(text.slice(copied));
  return parts.join("");
};

const cleanTypescript =
  (vocabulary: Vocabulary) =>
  (text: string): string =>
    joinStrandedHyphens(vocabulary, text.replaceAll(/ {2,}/gu, " "));

/**
 * Read a text's printed lines as a typescript: `null` for a text that is
 * not one, whose lines then stay as they are. `null` entries (anything that
 * is not body text at that position) always break.
 */
export const readHardWrap = (
  lines: readonly (PrintedLine | null)[],
): HardWrapReading | null => {
  const margin = hardWrapMarginOf(lines);
  if (margin === null) {
    return null;
  }
  const vocabulary = vocabularyOf(
    lines.flatMap((line) => (line === null ? [] : [line.text])),
  );
  return {
    margin,
    joins: lines
      .slice(0, -1)
      .map((above, index) =>
        joinOf(above, lines[index + 1] ?? null, margin, vocabulary),
      ),
    clean: cleanTypescript(vocabulary),
  };
};

/**
 * Plain-text lines (an abstract cell, one `<br>` per printed line) as
 * paragraphs. A text that is not a typescript keeps its lines.
 */
export const reflowPrintedText = (rawLines: readonly string[]): string[] => {
  const lines = rawLines.map(printedLine);
  const reading = readHardWrap(lines);
  if (reading === null) {
    return lines.map(({ text }) => text);
  }
  const paragraphs: string[] = [];
  let current: string[] = [lines[0]?.text ?? ""];
  for (const [index, join] of reading.joins.entries()) {
    const next = lines[index + 1]?.text ?? "";
    switch (join) {
      case LINE_JOINS.BREAK:
        paragraphs.push(reading.clean(current.join("")));
        current = [next];
        break;
      case LINE_JOINS.SPACE:
        current.push(" ", next);
        break;
      case LINE_JOINS.WORD:
        current[current.length - 1] = (current.at(-1) ?? "").slice(0, -1);
        current.push(next);
        break;
      case LINE_JOINS.COMPOUND:
        current.push(next);
        break;
      default: {
        join satisfies never;
        panic("Unhandled line join");
      }
    }
  }
  paragraphs.push(reading.clean(current.join("")));
  return paragraphs;
};

const PDF_PARAGRAPH = {
  indentHeightShare: 0.5,
  // Sparse pages still need a bound on ordinary line spacing.
  maxPitchHeightShare: 2,
  minPitchObservations: 2,
  pitchRounding: 2,
  gapToleranceHeightShare: 0.5,
  shortLineWidthShare: 0.75,
  shortLineGapHeightShare: 2,
} as const;

/** PDF geometry is in points; page coordinates restart on each page. */
export type PdfPrintedLine = {
  readonly text: string;
  readonly layout?: {
    readonly x: number;
    readonly y: number;
    readonly height: number;
    readonly width: number;
    readonly pageIndex: number;
  };
};

type PdfPageLayout = {
  left: number;
  right: number;
  height: number;
  pitch: number;
  pitches: Map<number, number>;
};

/** The modal line pitch tolerates extraction jitter without using a paragraph gap. */
const pdfPageLayouts = (lines: readonly (PdfPrintedLine | null)[]) => {
  const pages = new Map<number, PdfPageLayout>();
  let previous: PdfPrintedLine["layout"];
  for (const line of lines) {
    const layout = line?.layout;
    if (layout === undefined) {
      previous = undefined;
      continue;
    }
    const page = pages.get(layout.pageIndex) ?? {
      left: layout.x,
      right: layout.x + layout.width,
      height: layout.height,
      pitch: layout.height * PDF_PARAGRAPH.maxPitchHeightShare,
      pitches: new Map<number, number>(),
    };
    page.left = Math.min(page.left, layout.x);
    page.right = Math.max(page.right, layout.x + layout.width);
    page.height = Math.max(page.height, layout.height);
    if (previous?.pageIndex === layout.pageIndex) {
      const step = Math.abs(layout.y - previous.y);
      if (step >= Math.max(layout.height, previous.height)) {
        const pitch =
          Math.round(step * PDF_PARAGRAPH.pitchRounding) /
          PDF_PARAGRAPH.pitchRounding;
        const count = (page.pitches.get(pitch) ?? 0) + 1;
        page.pitches.set(pitch, count);
        const modalCount = page.pitches.get(page.pitch) ?? 0;
        if (
          count > modalCount ||
          (count === modalCount && pitch < page.pitch)
        ) {
          page.pitch = pitch;
        }
      }
    }
    pages.set(layout.pageIndex, page);
    previous = layout;
  }
  return pages;
};

/**
 * PDF geometry, rather than punctuation, decides where printed paragraphs end.
 * The right margin and ordinary line pitch come from the page's running prose;
 * null entries isolate titles and other display lines. Without geometry the
 * shared text classifier and sentence boundaries must decide the wrap.
 */
export const readPdfLineJoins = (lines: readonly (PdfPrintedLine | null)[]) => {
  const classification = classifyLineWrap(
    lines.map((line) => line?.text ?? null),
  );
  const pages = pdfPageLayouts(lines);
  return lines.map((line, index) => {
    const above = index > 0 ? lines.at(index - 1) : null;
    if (above === undefined || above === null || line === null) {
      return LINE_JOIN.BREAK;
    }
    const previousLayout = above.layout;
    const layout = line.layout;
    if (previousLayout === undefined || layout === undefined) {
      if (
        SENTENCE_END_RE.test(above.text) &&
        OPENS_SENTENCE_RE.test(line.text) &&
        !PRENOMINAL_TITLE_END_RE.test(above.text)
      ) {
        return LINE_JOIN.BREAK;
      }
      return lineJoinOf(classification, above.text, line.text);
    }
    const page =
      pages.get(previousLayout.pageIndex) ??
      panic("PDF line has no page layout");
    const height = Math.max(previousLayout.height, layout.height);
    if (previousLayout.pageIndex === layout.pageIndex) {
      const pitchObservations = page.pitches.get(page.pitch) ?? 0;
      const pitch =
        pitchObservations >= PDF_PARAGRAPH.minPitchObservations
          ? page.pitch
          : Math.min(
              page.pitch,
              page.height * PDF_PARAGRAPH.maxPitchHeightShare,
            );
      const indented =
        layout.x - previousLayout.x > height * PDF_PARAGRAPH.indentHeightShare;
      const verticalGap = Math.abs(layout.y - previousLayout.y);
      if (
        indented ||
        verticalGap > pitch + height * PDF_PARAGRAPH.gapToleranceHeightShare
      ) {
        return LINE_JOIN.BREAK;
      }
    }
    // A short name line can still continue into a lowercase signature role.
    const shortFinalLine =
      OPENS_SENTENCE_RE.test(line.text) &&
      previousLayout.width <
        (page.right - page.left) * PDF_PARAGRAPH.shortLineWidthShare &&
      page.right - previousLayout.x - previousLayout.width >
        height * PDF_PARAGRAPH.shortLineGapHeightShare;
    return shortFinalLine && !PRENOMINAL_TITLE_END_RE.test(above.text)
      ? LINE_JOIN.BREAK
      : LINE_JOIN.SPACE;
  });
};
