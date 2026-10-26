/**
 * Hard-wrapped source text: the one classifier, and a display fallback.
 *
 * Some publishers serve a decision as fixed-width lines: a newline every
 * 60-80 characters, mid-sentence, each one a paragraph of its own.
 *
 * Paragraphs are rebuilt at ingestion. A parser joins a wrapped source's
 * lines into real paragraphs and stores those; the raw payload stays the
 * verbatim published record. `classifyLineWrap` is the single decision of
 * whether a text is fixed-width wrapped and at which column, and
 * `lineJoinOf` reads one line boundary of such a text: whether the line
 * continues the one before it. Parsers call them (see
 * `apps/api/src/lib/legal-search/parsers/hard-wrapped-lines.ts` and the
 * Slovak general courts' PDF parser) rather than detecting wrapping
 * themselves.
 *
 * The planning below (`planLineWrap`, `planBlockLineWrap`) is a fallback for
 * rows stored before their parser rebuilt paragraphs: a reader draws such a
 * row's wrapped lines joined without changing what is stored. It is deleted
 * once the corpus is re-parsed, that is when no stored decision of a source
 * whose parser rebuilds paragraphs carries a parser version below the one
 * that began to (for the Czech Constitutional Court, version 28). A row
 * parsed since holds real paragraphs, which the classifier reads as
 * unwrapped, so the fallback leaves it as stored.
 *
 * The fallback rewrites no text. A plan names, per boundary, what a reader
 * draws between two lines: a paragraph break, a space, or nothing (after a
 * line-end hyphen). Every line keeps its own characters and offsets, so
 * search ranges, annotation offsets and block anchors are untouched by
 * construction.
 *
 * The fallback never drops a line-end hyphen. Czech, Slovak and Polish print
 * real hyphens in compounds ("sociálně-právní", "česko-slovenský") and a
 * hyphen the wrapper added is indistinguishable from one without evidence,
 * so the hyphen stays and the two lines are drawn without a space between
 * them: exact for a compound, readable for a soft break. At ingestion the
 * whole document is that evidence: a hyphen goes only where the source
 * marks it soft or spells the joined word elsewhere.
 */

// parser-output-unchanged: [cz-us] that parser reads only `classifyLineWrap`, which is unchanged; the date rule is in `lineJoinOf`, which it does not call.
import type { Block, ParagraphBlock, ParagraphRole } from "./document-ast.js";

export const LINE_WRAP_TYPE = {
  FIXED_WIDTH_WRAPPED: "fixed-width-wrapped",
  UNWRAPPED: "unwrapped",
} as const;

export type LineWrapClassification =
  | {
      type: typeof LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED;
      /** The wrap column: the longest line that is not an outlier. */
      width: number;
      /** The weaker of the two wrap signals, 0..1, two decimals. */
      confidence: number;
    }
  | { type: typeof LINE_WRAP_TYPE.UNWRAPPED };

export const LINE_JOIN = {
  BREAK: "break",
  SPACE: "space",
  HYPHEN: "hyphen",
} as const;

export type LineJoin = (typeof LINE_JOIN)[keyof typeof LINE_JOIN];

type LineContinuation = Exclude<LineJoin, typeof LINE_JOIN.BREAK>;

/** What a reader draws between two lines it joins. */
export const LINE_CONTINUATION_SEPARATOR = {
  space: " ",
  hyphen: "",
} as const satisfies Record<LineContinuation, string>;

/**
 * One line of the document, or `null` for a block that is not running prose
 * (a heading, a table, a signature). A null or blank line is a hard break.
 */
type WrapLine = string | null;

type LineWrapPlan = {
  classification: LineWrapClassification;
  /** `joins[i]` sits between `lines[i]` and `lines[i + 1]`. */
  joins: LineJoin[];
};

const MIN_WRAPPED_LINES = 8;
const MIN_WRAP_WIDTH = 30;
const MAX_WRAP_WIDTH = 160;
/** Lines longer than this multiple of the 90th percentile are outliers. */
const OUTLIER_FACTOR = 1.15;
/** A full line ends within this share of the width from the wrap column. */
const FULL_LINE_SLACK = 0.25;
const MIN_FULL_LINE_SHARE = 0.55;
const MIN_MID_SENTENCE_SHARE = 0.4;
/** How far short of the column a wrapped line may stop and still be full. */
const FIT_TOLERANCE = 0.12;
/** A line at most this share of the width may be a heading. */
const SHORT_LINE_SHARE = 0.5;

/** Sentence-final punctuation, optionally closed by quotes or brackets. */
const TERMINAL_END_RE = /[.!?:;]["'’“”»«)\]]*$/u;
/** A short abbreviation ("č.", "odst.", "Čl.") ending a line. */
const ABBREVIATION_END_RE = /(?:^|[\s(])\p{L}\p{Ll}{0,4}\.$/u;
/**
 * A pre-nominal academic title ending a line: it always precedes a name, so
 * it never ends a sentence. Post-nominal ones ("Ph.D.") can, and are absent.
 */
const TITLE_END_RE =
  /(?:^|\s)(?:JUDr|Mgr|MgA|Ing|MUDr|MVDr|PhDr|RNDr|PaedDr|ThDr|doc|prof|Bc|Dr|Mr|Mrs|Ms)\.$/u;
/** A letter followed by a hyphen at the line end: no space before it. */
const HYPHEN_END_RE = /\p{L}-$/u;
const LOWERCASE_START_RE = /^\p{Ll}/u;
const LETTER_START_RE = /^\p{L}/u;
const DIGIT_START_RE = /^\d/u;

/**
 * Line openings that start a new unit whatever came before: numbered points
 * ("1. Stěžovatel", "2) ", "(3) "; "4. listopadu" is a date, not a point),
 * Roman points ("II. ", "IV."), letter items ("a) ", "(b) "), bullets and
 * dashes, and an indented line.
 */
const STRUCTURAL_START_RES = [
  /^\(?\d{1,3}\.(?:\s+(?!\p{Ll})|$)/u,
  /^\(?\d{1,3}\)(?:\s|$)/u,
  /^\(?[IVXLC]{1,6}[.)](?:\s|$)/u,
  /^\(?\p{L}\)(?:\s|$)/u,
  /^[-–—•*·](?:\s|$)/u,
  /^\s/u,
] as const;

/** Every letter uppercase, at least two of them: "N Á L E Z", "ODŮVODNĚNÍ". */
const isAllCaps = (line: string): boolean => {
  const letters = line.match(/\p{L}/gu) ?? [];
  return letters.length >= 2 && !/\p{Ll}/u.test(line);
};

const firstWordLength = (line: string): number =>
  line.trimStart().split(/\s/u, 1).at(0)?.length ?? 0;

const isBlank = (line: WrapLine): line is null | "" =>
  line === null || line.trim() === "";

/** The prose lines' lengths, the only lines that say anything about wrapping. */
const proseLengths = (lines: readonly WrapLine[]): number[] => {
  const lengths: number[] = [];
  for (const line of lines) {
    if (!isBlank(line)) {
      lengths.push(line.length);
    }
  }
  return lengths;
};

/** The wrap column: the longest line once outliers (a long URL) are set aside. */
const wrapWidth = (lengths: readonly number[]): number => {
  const sorted = lengths.toSorted((a, b) => a - b);
  const p90 = sorted.at(Math.floor((sorted.length - 1) * 0.9)) ?? 0;
  const ceiling = Math.ceil(p90 * OUTLIER_FACTOR);
  let width = 0;
  for (const length of sorted) {
    if (length <= ceiling) {
      width = length;
    }
  }
  return width;
};

const isMidSentence = (previous: string, next: string): boolean =>
  !TERMINAL_END_RE.test(previous) || LOWERCASE_START_RE.test(next);

/** The two wrap signals over a document, or null when it is too small. */
const wrapEvidence = (lines: readonly WrapLine[]) => {
  const lengths = proseLengths(lines);
  if (lengths.length < MIN_WRAPPED_LINES) {
    return null;
  }
  const width = wrapWidth(lengths);
  const fullFrom = width - Math.round(width * FULL_LINE_SLACK);
  const fullLines = lengths.filter(
    (length) => length >= fullFrom && length <= width,
  ).length;
  let pairs = 0;
  let midSentence = 0;
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const previous = lines[index] ?? null;
    const next = lines[index + 1] ?? null;
    if (isBlank(previous) || isBlank(next)) {
      continue;
    }
    pairs += 1;
    if (isMidSentence(previous, next)) {
      midSentence += 1;
    }
  }
  return {
    width,
    fullShare: fullLines / lengths.length,
    midSentenceShare: pairs === 0 ? 0 : midSentence / pairs,
  };
};

/**
 * Whether a document's lines were wrapped at a fixed column.
 *
 * Two signals must both hold: most prose lines end near one column (the
 * shape a fixed-width wrapper leaves), and many line boundaries fall inside
 * a sentence (what a paragraph break never does). A normal document whose
 * paragraphs are merely short fails the second; one with a few short lines
 * fails the first.
 */
export const classifyLineWrap = (
  lines: readonly WrapLine[],
): LineWrapClassification => {
  const evidence = wrapEvidence(lines);
  if (
    evidence === null ||
    evidence.width < MIN_WRAP_WIDTH ||
    evidence.width > MAX_WRAP_WIDTH ||
    evidence.fullShare < MIN_FULL_LINE_SHARE ||
    evidence.midSentenceShare < MIN_MID_SENTENCE_SHARE
  ) {
    return { type: LINE_WRAP_TYPE.UNWRAPPED };
  }
  return {
    type: LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED,
    width: evidence.width,
    confidence:
      Math.round(
        Math.min(evidence.fullShare, evidence.midSentenceShare) * 100,
      ) / 100,
  };
};

const isHeadingLike = (line: string, width: number): boolean =>
  line.length <= width * SHORT_LINE_SHARE &&
  (isAllCaps(line) || line.trimEnd().endsWith(":"));

/** A numeric date ("12. 3. 1998", "1.2.1999") continues a sentence. */
const NUMERIC_DATE_START_RE = /^\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}\b/u;
/**
 * A day number ending a line after a word that introduces a date: "dňa 22.",
 * "zo 22.", "od 22.", "do 22." (Slovak, Czech and Polish). A bare number
 * ("v bode 22.") is not a day: the next line may open the next point.
 */
const DAY_END_RE =
  /(?:^|\s)(?:dňa|dna|dne|dnia|od|do|zo|ze|z|k|ku)\s+(?:0?[1-9]|[12]\d|3[01])\.$/iu;
/** A month and a year opening a line: "10. 2003". */
const MONTH_YEAR_START_RE = /^(?:0?[1-9]|1[0-2])\.\s?\d{4}\b/u;

/**
 * A numeric date the wrapper split after its day ("dňa 22." / "10. 2003"):
 * the month opens the next line like a numbered point would, but a point is
 * not introduced by "dňa" and followed by a year.
 */
export const splitsDate = (previous: string, next: string): boolean =>
  DAY_END_RE.test(previous) && MONTH_YEAR_START_RE.test(next);

const startsStructurally = (line: string): boolean =>
  !NUMERIC_DATE_START_RE.test(line) &&
  STRUCTURAL_START_RES.some((pattern) => pattern.test(line));

/**
 * What a reader draws between two adjacent prose lines of a wrapped document.
 *
 * Joined only when the wrapper, not the author, ended the line:
 * - neither line is longer than the wrap column, neither looks like a
 *   heading, and the next does not open a numbered point, list item or
 *   indented paragraph;
 * - the next line's first word would not have fit on the previous line (a
 *   full previous line gets a tolerance: a proportional-font export wraps by
 *   glyph width rather than character count), and the two lines together
 *   are longer than the column, so a joined line is never joinable again;
 * - and the boundary is inside a sentence: the previous line ends without
 *   sentence-final punctuation, or the next starts lowercase, or the
 *   previous ends with a short abbreviation ("č.", "odst.") and the next
 *   with a digit, or with an academic title ("JUDr.") and the next with a
 *   letter, or the previous ends with a day number and the next opens with
 *   the month and year of that date.
 * A line opening with an academic title ("JUDr. A. B.") inside a sentence
 * continues it like any other capitalised word: only a line the author
 * ended (short of the column, or after a full stop) puts a signature on a
 * line of its own.
 * A letter-hyphen line end followed by a letter joins without a space and
 * keeps the hyphen.
 */
const joinAt = (previous: string, next: string, width: number): LineJoin => {
  const dateGoesOn = splitsDate(previous, next);
  if (
    previous.length > width ||
    next.length > width ||
    isHeadingLike(previous, width) ||
    isHeadingLike(next, width) ||
    (!dateGoesOn && startsStructurally(next))
  ) {
    return LINE_JOIN.BREAK;
  }
  const hyphenated = HYPHEN_END_RE.test(previous) && LETTER_START_RE.test(next);
  const separator = hyphenated
    ? LINE_CONTINUATION_SEPARATOR.hyphen
    : LINE_CONTINUATION_SEPARATOR.space;
  const withNextWord =
    previous.length + separator.length + firstWordLength(next);
  // Short of the column only a full line may claim the tolerance: a short
  // line before a long word would otherwise pass for a wrapped one.
  const nextWordOverflows =
    withNextWord > width ||
    (withNextWord > width - Math.round(width * FIT_TOLERANCE) &&
      previous.length >= width - Math.round(width * FULL_LINE_SLACK));
  const joinedOverflows =
    previous.length + separator.length + next.length > width;
  if (!nextWordOverflows || !joinedOverflows) {
    return LINE_JOIN.BREAK;
  }
  if (hyphenated) {
    return LINE_JOIN.HYPHEN;
  }
  const continues =
    dateGoesOn ||
    isMidSentence(previous, next) ||
    (ABBREVIATION_END_RE.test(previous) && DIGIT_START_RE.test(next)) ||
    (TITLE_END_RE.test(previous) && LETTER_START_RE.test(next));
  return continues ? LINE_JOIN.SPACE : LINE_JOIN.BREAK;
};

/**
 * How `next` follows `previous`, two adjacent lines of a document
 * `classifyLineWrap` read: a break unless the document is fixed-width
 * wrapped and the wrapper, not the author, ended `previous` (see `joinAt`).
 * A null or blank line always breaks.
 */
export const lineJoinOf = (
  classification: LineWrapClassification,
  previous: WrapLine,
  next: WrapLine,
): LineJoin =>
  classification.type === LINE_WRAP_TYPE.UNWRAPPED ||
  isBlank(previous) ||
  isBlank(next)
    ? LINE_JOIN.BREAK
    : joinAt(previous, next, classification.width);

/**
 * The display plan for a sequence of lines: every boundary a break unless
 * the document is fixed-width wrapped, and then only the wrapper's breaks
 * joined.
 */
export const planLineWrap = (lines: readonly WrapLine[]): LineWrapPlan => {
  const classification = classifyLineWrap(lines);
  const joins: LineJoin[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    joins.push(
      lineJoinOf(
        classification,
        lines[index] ?? null,
        lines[index + 1] ?? null,
      ),
    );
  }
  return { classification, joins };
};

type WrapRoleDisposition = "reflow" | "fixed";

/**
 * Which paragraph roles are running prose a wrapped line may continue.
 * Layout roles (signatures, front matter) keep their lines, a reproduced
 * quotation is drawn as printed, and the publisher roles the reader lifts
 * into its top matter or folds away are drawn block by block there.
 */
const WRAP_ROLE_DISPOSITION = {
  "case-number": "fixed",
  intro: "reflow",
  history: "reflow",
  argumentation: "reflow",
  holding: "reflow",
  dissent: "reflow",
  closing: "fixed",
  signature: "fixed",
  quote: "fixed",
  parties: "fixed",
  "front-matter": "fixed",
  apparatus: "fixed",
  syllabus: "fixed",
  headnotes: "fixed",
  summary: "fixed",
  counsel: "fixed",
  panel: "fixed",
  unknown: "reflow",
} as const satisfies Record<ParagraphRole, WrapRoleDisposition>;

const reflowableParagraph = (block: Block): block is ParagraphBlock =>
  block.type === "paragraph" &&
  block.number === undefined &&
  block.note === undefined &&
  block.listDepth === undefined &&
  (block.role === undefined ||
    WRAP_ROLE_DISPOSITION[block.role] === "reflow") &&
  !block.plainText.includes("\n");

type BlockLineWrapPlan = {
  classification: LineWrapClassification;
  /**
   * Blocks a reader draws as the continuation of the block before them,
   * by block id, with what to draw between the two.
   */
  continuations: ReadonlyMap<string, LineContinuation>;
};

/**
 * The display plan over a document's blocks: one line per block, as a
 * hard-wrapped source is stored. Only adjacent prose paragraphs of the same
 * role join; anything else is a hard break.
 */
export const planBlockLineWrap = (
  blocks: readonly Block[],
): BlockLineWrapPlan => {
  const { classification, joins } = planLineWrap(
    blocks.map((block) =>
      reflowableParagraph(block) ? block.plainText : null,
    ),
  );
  const continuations = new Map<string, LineContinuation>();
  for (const [index, join] of joins.entries()) {
    const previous = blocks[index];
    const next = blocks[index + 1];
    if (
      join === LINE_JOIN.BREAK ||
      previous?.type !== "paragraph" ||
      next?.type !== "paragraph" ||
      previous.role !== next.role
    ) {
      continue;
    }
    continuations.set(next.id, join);
  }
  return { classification, continuations };
};
