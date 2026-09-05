/**
 * Where the eye should land when reading two passages side by side.
 *
 * Three marks, in increasing strength. A *diff* run is a word the other side
 * words differently; a *term* is a quantity, date, or defined term, marked
 * the same way on both sides so the pair reads as one comparison; a *delta*
 * is the exact phrase a graded finding named, and it outranks the other two
 * wherever they overlap.
 *
 * Everything here is text in, ranges out: the component only renders what
 * these functions decide, so the matching is unit-testable without a DOM.
 */

import { panic } from "better-result";

import { diffWords } from "@/components/ai-suggestions/review-word-diff";

export const KEY_TERM_KIND = {
  /** A run the word diff says the other side words differently. */
  diff: "diff",
  /** A quantity, date, or defined term. Marked identically on both sides. */
  term: "term",
  /** The exact phrase a `parameter` delta names on this side. */
  delta: "delta",
} as const;

export type KeyTermKind = (typeof KEY_TERM_KIND)[keyof typeof KEY_TERM_KIND];

/** A half-open `[start, end)` slice of one side's text. */
export type KeyTermRange = { start: number; end: number; kind: KeyTermKind };

/**
 * One run of text and the mark it carries; `null` renders unmarked. `start`
 * is the run's offset in the text it came from, which gives the renderer a
 * stable key without falling back to the array index.
 */
export type MarkedSegment = {
  start: number;
  text: string;
  kind: KeyTermKind | null;
};

/**
 * Which mark survives where two overlap. A delta names the phrase the finding
 * is *about*, so it wins over the generic quantity marking that would
 * otherwise cover the same digits; a term wins over a diff run because the
 * term is the thing being compared, the diff only says it moved.
 */
const KIND_PRECEDENCE = {
  diff: 0,
  term: 1,
  delta: 2,
} as const satisfies Record<KeyTermKind, number>;

/**
 * Above this share of changed tokens the diff has stopped discriminating:
 * marking it would wash the whole passage, so key terms carry the pair alone.
 */
export const DIFF_SATURATION_LIMIT = 0.6;

/**
 * The word diff is quadratic in tokens. Past this many characters on either
 * side the pair falls back to key-term marking alone rather than allocating a
 * table the size of an image for a reading nobody scans word by word.
 */
export const DIFF_LENGTH_LIMIT = 8000;

// A one-liner rather than an import: the existing copy lives in the case-law
// slice, and reaching across for it would pull that slice's module graph into
// the review bundle.
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const LETTER = String.raw`[\p{L}\p{M}]`;
/** Nothing that would make the match a fragment of a longer word or number. */
const LEADING_BOUNDARY = String.raw`(?<![\p{L}\p{M}\d.,])`;
const TRAILING_BOUNDARY = String.raw`(?![\p{L}\p{M}\d])`;

/**
 * Duration and quantity words, in the languages the corpus is reviewed in.
 * The alternation is built longest-first, so "business days" wins over
 * "days" and "měsíců" over "měsíc".
 */
const UNIT_WORDS = [
  "business days",
  "business day",
  "calendar days",
  "calendar day",
  "working days",
  "working day",
  "days",
  "day",
  "weeks",
  "week",
  "months",
  "month",
  "years",
  "year",
  "hours",
  "hour",
  "minutes",
  "minute",
  "per cent",
  "percent",
  "pracovních dnů",
  "dnů",
  "dní",
  "dny",
  "den",
  "týdnů",
  "týdny",
  "týden",
  "měsíců",
  "měsíce",
  "měsíc",
  "let",
  "roky",
  "roku",
  "rok",
  "hodin",
  "hodiny",
  "hodina",
  "procent",
  "procenta",
  "procentu",
  "dni roboczych",
  "dni",
  "dnia",
  "dzień",
  "tygodni",
  "tygodnie",
  "tydzień",
  "miesięcy",
  "miesiące",
  "miesiąc",
  "lat",
  "lata",
  "godzin",
  "godziny",
  "godzina",
  // Scale words: what follows a figure and multiplies it.
  "millions",
  "million",
  "billions",
  "billion",
  "thousand",
  "miliónů",
  "milionů",
  "milionu",
  "milión",
  "milion",
  "miliardy",
  "miliard",
  "tisíc",
  "milionów",
  "miliardów",
  "tysięcy",
  "tysiąc",
  "mln",
  "mld",
];

const CURRENCY_WORDS = [
  "PLN",
  "EUR",
  "CZK",
  "USD",
  "GBP",
  "CHF",
  "HUF",
  "RON",
  "SEK",
  "NOK",
  "DKK",
  "JPY",
  "€",
  "$",
  "£",
  "¥",
  "zł",
  "Kč",
  "Ft",
];

/** Words that make a preceding capitalised word a defined term. */
const DEFINITION_VERBS = ["means", "shall mean", "znamená", "oznacza"];

/** Longest-first, so a shorter prefix cannot win the alternation. */
const alternation = (words: readonly string[]): string =>
  [...new Set(words)]
    .toSorted((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");

/** Thousands may be grouped by space, non-breaking space, dot, comma, or apostrophe. */
const NUMBER = String.raw`\d{1,3}(?:[\s  .,']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
/** A redacted figure the draft has not filled in: `[●]`, `[__]`, `[TBD]`. */
const PLACEHOLDER = String.raw`\[[^\]\n]{1,12}\]`;
const AMOUNT = `(?:${PLACEHOLDER}|${NUMBER})`;
/** The spelled-out repeat legal drafting puts beside a figure: `12 (twelve)`. */
const SPELLED_OUT = String.raw`\s*\([^()\n]{1,40}\)`;

const DATE_PATTERNS = [
  // 30 June 2025 · 30. června 2025 · 30 czerwca 2025
  String.raw`\d{1,2}\.?\s+${LETTER}{3,12}\.?\s+\d{4}`,
  // 30. 6. 2025
  String.raw`\d{1,2}\.\s?\d{1,2}\.\s?\d{4}`,
  String.raw`\d{4}-\d{2}-\d{2}`,
  String.raw`\d{1,2}/\d{1,2}/\d{2,4}`,
];

/**
 * A bare number is not a key term — it is as likely to be a clause number as
 * an amount. What makes a figure worth marking is what sits beside it: a
 * date's month, a currency, a percent sign, a unit, or the spelled-out repeat.
 */
const QUANTITY_PATTERN = new RegExp(
  `${LEADING_BOUNDARY}(?:${[
    ...DATE_PATTERNS,
    `${AMOUNT}(?:${SPELLED_OUT})?\\s*%`,
    `${AMOUNT}(?:${SPELLED_OUT})?\\s*(?:${alternation(UNIT_WORDS)})${TRAILING_BOUNDARY}`,
    `${AMOUNT}${SPELLED_OUT}`,
    `(?:${alternation(CURRENCY_WORDS)})\\s*${AMOUNT}`,
    `${AMOUNT}\\s*(?:${alternation(CURRENCY_WORDS)})${TRAILING_BOUNDARY}`,
  ].join("|")})`,
  "gu",
);

/**
 * Title Case, not merely capitalised: an all-caps word is a heading, and
 * marking headings would paint whole lines. A single capitalised word counts
 * only where the sentence says it is being defined — followed by a closing
 * bracket, or by "means" and its Czech and Polish equivalents.
 */
const TITLE_WORD = String.raw`\p{Lu}[\p{Ll}\p{M}]+(?:[-'’][\p{Lu}\p{Ll}\p{M}]+)*`;
/** Drafting quotes a term as it defines it: `"Leakage" means …`. */
const CLOSING_QUOTE = String.raw`["'”’»„]?`;
const DEFINED_TERM_PATTERN = new RegExp(
  `(?<!${LETTER})(?:${TITLE_WORD}(?:\\s+${TITLE_WORD})+|${TITLE_WORD}(?=${CLOSING_QUOTE}\\s*\\)|${CLOSING_QUOTE}\\s+(?:${alternation(
    DEFINITION_VERBS,
  )})${TRAILING_BOUNDARY}))`,
  "gu",
);

/**
 * A clause number the block carries as its own first token: `2.1`, `13.18.`,
 * `(a)`, `b)`. A bare integer is deliberately not one — a passage may open
 * with a figure — and neither is a decimal that reads as a quantity, which is
 * what the unit check rules out.
 */
const CLAUSE_LABEL_PATTERN =
  /^\s*(\d+(?:\.\d+)+\.?|\d+\.|\(\s*[\p{L}\d]{1,5}\s*\)|\p{L}\d?\))\s+/u;
const LEADING_UNIT_PATTERN = new RegExp(
  `^(?:${alternation(UNIT_WORDS)}|${alternation(CURRENCY_WORDS)})${TRAILING_BOUNDARY}`,
  "iu",
);

/** A leading clause number and the prose after it. */
export type ClauseSplit = { label: string | null; body: string };

export const splitClauseLabel = (text: string): ClauseSplit => {
  const match = CLAUSE_LABEL_PATTERN.exec(text);
  const label = match?.[1];
  if (match === null || label === undefined) {
    return { body: text.trim(), label: null };
  }
  const body = text.slice(match[0].length).trim();
  // `1.5 million` is a quantity that happens to look like a clause number.
  if (LEADING_UNIT_PATTERN.test(body)) {
    return { body: text.trim(), label: null };
  }
  return { body, label };
};

const MEANINGLESS_RUN = /^[\s\p{P}\p{S}]*$/u;

const matchRanges = (
  text: string,
  pattern: RegExp,
  kind: KeyTermKind,
): KeyTermRange[] =>
  [...text.matchAll(pattern)].map((match) => ({
    end: match.index + match[0].length,
    kind,
    start: match.index,
  }));

/** Every quantity, date, and defined term in one side's text. */
export const keyTermRanges = (text: string): KeyTermRange[] => [
  ...matchRanges(text, QUANTITY_PATTERN, KEY_TERM_KIND.term),
  ...matchRanges(text, DEFINED_TERM_PATTERN, KEY_TERM_KIND.term),
];

/**
 * Every occurrence of one phrase, matched across whatever whitespace the
 * block happens to use: a delta's `text` is quoted from the block, but the
 * extraction may have normalised a line break into a space.
 */
export const phraseRanges = (text: string, phrase: string): KeyTermRange[] => {
  const words = phrase
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }
  const pattern = new RegExp(
    words.map(escapeRegExp).join(String.raw`\s+`),
    "giu",
  );
  return matchRanges(text, pattern, KEY_TERM_KIND.delta);
};

type DiffHighlightInput = { standardText: string; targetText: string };

/** Differing runs on each side, in that side's own coordinates. */
export type DiffHighlight = {
  standard: KeyTermRange[];
  target: KeyTermRange[];
};

/**
 * The word diff, read as highlight rather than redline: each side keeps its
 * own text and only learns which of its runs the other side words otherwise.
 * Nothing is struck through, because neither side is a correction of the
 * other — they are two documents being compared.
 */
export const diffHighlightRanges = ({
  standardText,
  targetText,
}: DiffHighlightInput): DiffHighlight => {
  if (
    standardText.length > DIFF_LENGTH_LIMIT ||
    targetText.length > DIFF_LENGTH_LIMIT
  ) {
    return { standard: [], target: [] };
  }

  const ops = diffWords(standardText, targetText);
  const changed = ops.filter((op) => op.type !== "equal").length;
  if (ops.length === 0 || changed / ops.length > DIFF_SATURATION_LIMIT) {
    return { standard: [], target: [] };
  }

  const standard: KeyTermRange[] = [];
  const target: KeyTermRange[] = [];
  let standardCursor = 0;
  let targetCursor = 0;
  for (const op of ops) {
    switch (op.type) {
      case "equal":
        standardCursor += op.token.length;
        targetCursor += op.token.length;
        break;
      case "delete":
        extendRun(standard, standardCursor, op.token.length);
        standardCursor += op.token.length;
        break;
      case "insert":
        extendRun(target, targetCursor, op.token.length);
        targetCursor += op.token.length;
        break;
      default:
        op.type satisfies never;
        panic(`Unhandled type: ${String(op.type)}`);
    }
  }

  return {
    standard: tidyRuns(standardText, standard),
    target: tidyRuns(targetText, target),
  };
};

/** Adjacent tokens are one mark, not one mark per token. */
const extendRun = (runs: KeyTermRange[], start: number, length: number) => {
  const last = runs.at(-1);
  if (last?.end === start) {
    last.end = start + length;
    return;
  }
  runs.push({ end: start + length, kind: KEY_TERM_KIND.diff, start });
};

/**
 * Trims each run to the text that carries meaning and drops what is left of a
 * run that was only spacing or punctuation: a moved comma is not a finding.
 */
const tidyRuns = (text: string, runs: readonly KeyTermRange[]) => {
  const tidied: KeyTermRange[] = [];
  for (const run of runs) {
    const slice = text.slice(run.start, run.end);
    if (MEANINGLESS_RUN.test(slice)) {
      continue;
    }
    const leading = slice.length - slice.trimStart().length;
    const trailing = slice.length - slice.trimEnd().length;
    tidied.push({
      end: run.end - trailing,
      kind: run.kind,
      start: run.start + leading,
    });
  }
  return tidied;
};

type ResolveMarkedSegmentsInput = {
  text: string;
  ranges: readonly KeyTermRange[];
};

/**
 * Flattens overlapping ranges into the runs a renderer can walk once. The
 * output always reconstructs `text` exactly, so nothing can be dropped or
 * duplicated by the marking.
 */
export const resolveMarkedSegments = ({
  text,
  ranges,
}: ResolveMarkedSegmentsInput): MarkedSegment[] => {
  const kinds: (KeyTermKind | null)[] = Array.from(
    { length: text.length },
    () => null,
  );
  for (const range of ranges) {
    const start = Math.max(0, range.start);
    const end = Math.min(text.length, range.end);
    for (let index = start; index < end; index++) {
      const current = kinds[index];
      if (current === undefined) {
        continue;
      }
      if (
        current === null ||
        KIND_PRECEDENCE[range.kind] > KIND_PRECEDENCE[current]
      ) {
        kinds[index] = range.kind;
      }
    }
  }

  const segments: MarkedSegment[] = [];
  let cursor = 0;
  for (let index = 1; index <= text.length; index++) {
    if (index < text.length && kinds[index] === kinds[cursor]) {
      continue;
    }
    segments.push({
      kind: kinds[cursor] ?? null,
      start: cursor,
      text: text.slice(cursor, index),
    });
    cursor = index;
  }
  return segments;
};

/** One quoted block, as the pair receives it. */
export type PassageInput = { blockId: string; text: string };

/** One block ready to render: its clause label, and its marked-up prose. */
export type MarkedParagraph = {
  blockId: string;
  label: string | null;
  segments: MarkedSegment[];
};

export type MarkedPair = {
  standard: MarkedParagraph[];
  target: MarkedParagraph[];
};

export type BuildMarkedPairInput = {
  target: readonly PassageInput[];
  standard: readonly PassageInput[];
  /** The `parameter` delta's phrase on the target side, when it has one. */
  deltaTargetText?: string | undefined;
  /** The `parameter` delta's phrase on the standard side, when it has one. */
  deltaStandardText?: string | undefined;
};

/**
 * Both sides marked against each other. The diff runs on the two sides'
 * *joined* prose, so a passage split across several blocks compares as the
 * one continuous reading it is on the page.
 */
export const buildMarkedPair = ({
  target,
  standard,
  deltaTargetText,
  deltaStandardText,
}: BuildMarkedPairInput): MarkedPair => {
  const targetSide = joinSide(target);
  const standardSide = joinSide(standard);
  const diff = diffHighlightRanges({
    standardText: standardSide.text,
    targetText: targetSide.text,
  });
  return {
    standard: markSide(standardSide, [
      ...diff.standard,
      ...sideRanges(standardSide.text, deltaStandardText),
    ]),
    target: markSide(targetSide, [
      ...diff.target,
      ...sideRanges(targetSide.text, deltaTargetText),
    ]),
  };
};

/**
 * One side on its own: the same clause labels and the same key-term marks the
 * pair uses, with no diff. What a playbook's reference standard gets, where
 * there is no second side to be different from — marking every run as
 * "the other side words this differently" would be a claim about a comparison
 * that has not happened.
 */
export const buildMarkedSide = (
  passages: readonly PassageInput[],
): MarkedParagraph[] => {
  const side = joinSide(passages);
  return markSide(side, keyTermRanges(side.text));
};

/** Blocks read as paragraphs of one passage, so they join as paragraphs do. */
const PARAGRAPH_SEPARATOR = "\n\n";

type JoinedParagraph = {
  blockId: string;
  label: string | null;
  start: number;
  end: number;
};
type JoinedSide = { text: string; paragraphs: JoinedParagraph[] };

const joinSide = (passages: readonly PassageInput[]): JoinedSide => {
  const paragraphs: JoinedParagraph[] = [];
  const bodies: string[] = [];
  let cursor = 0;
  for (const passage of passages) {
    const { body, label } = splitClauseLabel(passage.text);
    if (bodies.length > 0) {
      cursor += PARAGRAPH_SEPARATOR.length;
    }
    paragraphs.push({
      blockId: passage.blockId,
      end: cursor + body.length,
      label,
      start: cursor,
    });
    bodies.push(body);
    cursor += body.length;
  }
  return { paragraphs, text: bodies.join(PARAGRAPH_SEPARATOR) };
};

const sideRanges = (
  text: string,
  deltaText: string | undefined,
): KeyTermRange[] => [
  ...keyTermRanges(text),
  ...(deltaText === undefined ? [] : phraseRanges(text, deltaText)),
];

const markSide = (
  side: JoinedSide,
  ranges: readonly KeyTermRange[],
): MarkedParagraph[] =>
  side.paragraphs.map((paragraph) => ({
    blockId: paragraph.blockId,
    label: paragraph.label,
    segments: resolveMarkedSegments({
      ranges: ranges
        .filter(
          (range) => range.end > paragraph.start && range.start < paragraph.end,
        )
        .map((range) => ({
          end: Math.min(range.end, paragraph.end) - paragraph.start,
          kind: range.kind,
          start: Math.max(range.start, paragraph.start) - paragraph.start,
        })),
      text: side.text.slice(paragraph.start, paragraph.end),
    }),
  }));
