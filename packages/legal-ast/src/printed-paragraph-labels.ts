/**
 * The labels a court prints at the start of a paragraph, read one way.
 *
 * Czech, Slovak and Polish decisions open their paragraphs and points with a
 * printed label: the court's paragraph number (`12.`, `[12]`, `12)`), a
 * sub-paragraph (`5.5.`, `1.1.`, `16.1.`), a statute-style subsection
 * (`(3)`), a lettered point (`a)`, `(b)`), a Roman part (`IV.`) or a dash.
 * The same characters also open lines that are no paragraph at all: a date
 * wrapped after its day (`dňa` / `2. júla 2014`, `ze dne` / `29. 4. 2016`), a
 * citation wrapped after the word its number belongs to (`písm.` / `b)`,
 * `art.` / `5 ust. 2`), or a sentence that goes on past a full line.
 *
 * This module is the one grammar for both questions: what label a line opens
 * with, and whether that label opens a paragraph after the line above: never
 * inside a wrapped date and never after a word that takes a number. The
 * court's paragraph number read
 * here is the one `extractCourtParagraphNumbers` moves into
 * `ParagraphBlock.number`.
 */

/** The shapes of a printed label. */
export const PRINTED_LABEL_KIND = {
  /** The court's paragraph or a list point: `12.`, `12)`. */
  NUMBER: "number",
  /** A bracketed paragraph number: `[12]`. */
  BRACKET: "bracket",
  /** A subsection in parentheses: `(3)`. */
  PARENTHESISED: "parenthesised",
  /** A numbered sub-paragraph: `5.5.`, `1.1.`, `16.1.`, `1.2.3.`. */
  SUBNUMBER: "subnumber",
  /** A lettered point: `a)`, `(b)`, `A)`. */
  LETTER: "letter",
  /** A Roman part of a ruling or a reasoning: `I.`, `IV.`, `II)`. */
  ROMAN: "roman",
  /** A dash or a bullet: `-`, `–`, `•`. */
  BULLET: "bullet",
} as const;

type PrintedLabelKind =
  (typeof PRINTED_LABEL_KIND)[keyof typeof PRINTED_LABEL_KIND];

type PrintedLabel = {
  readonly kind: PrintedLabelKind;
  /** The label as printed, without the space after it. */
  readonly marker: string;
  /** The text after the label and its space. */
  readonly rest: string;
};

/** Horizontal space a publisher sets after a label. */
const GAP = "[ \\t\\u00a0]+";

/**
 * Roman parts a decision runs to. Initials of anonymised names (`L.`, `C.`,
 * `M.`) read as Roman numbers too, so only the parts a ruling or reasoning
 * actually reaches count, and `II. ÚS` is a Constitutional Court docket.
 */
const ROMAN = "(?:XX|X{0,1}(?:IX|IV|V?I{1,3}|V))";

const LABEL_PATTERNS = [
  [
    PRINTED_LABEL_KIND.BRACKET,
    new RegExp(`^(\\[\\d{1,4}\\])(?:${GAP}|$)`, "u"),
  ],
  [
    PRINTED_LABEL_KIND.SUBNUMBER,
    new RegExp(`^(\\d{1,3}(?:\\.\\d{1,3})+\\.)${GAP}(?=[^\\s\\d])`, "u"),
  ],
  [
    PRINTED_LABEL_KIND.NUMBER,
    new RegExp(`^(\\d{1,4}[.)])(?:${GAP}(?=\\S)|(?=\\p{Lu}))`, "u"),
  ],
  [
    PRINTED_LABEL_KIND.PARENTHESISED,
    new RegExp(`^(\\(\\d{1,3}\\))${GAP}(?=\\S)`, "u"),
  ],
  [PRINTED_LABEL_KIND.LETTER, new RegExp(`^(\\(?\\p{L}\\))${GAP}(?=\\S)`, "u")],
  [
    PRINTED_LABEL_KIND.ROMAN,
    new RegExp(`^(${ROMAN}[.)])(?:${GAP}(?!ÚS\\b)(?=\\S)|$)`, "u"),
  ],
  [PRINTED_LABEL_KIND.BULLET, new RegExp(`^([-–•])${GAP}(?=\\S)`, "u")],
] as const satisfies readonly (readonly [PrintedLabelKind, RegExp])[];

/** The label a line opens with, or `null` for a line that opens with text. */
export const readPrintedLabel = (line: string): PrintedLabel | null => {
  const text = line.trimStart();
  for (const [kind, pattern] of LABEL_PATTERNS) {
    const match = pattern.exec(text);
    const marker = match?.[1];
    if (match !== null && marker !== undefined) {
      return { kind, marker, rest: text.slice(match[0].length) };
    }
  }
  return null;
};

/**
 * A list point's own number or bullet, as a positioned-line reader weighs
 * it against the line's geometry: `2.`, `IV.`, `a)`, `–`.
 */
export const LIST_POINT_RE =
  /^(?:(?:\d{1,3}|[IVXLC]{1,6}|\p{Ll})[.)]|[-–•])\s/u;

/** A point numbered in a way no wrapped sentence starts: `2.`, `2)`, `a)`. */
export const NUMBERED_POINT_RE = /^(?:\d{1,3}[.)]|\p{Ll}\))\s/u;

// ── Label shapes the line readers weigh with geometry ────

/**
 * Line openings a fixed-width wrap planner breaks before, whatever came
 * before: numbered points ("1. Stěžovatel", "2) ", "(3) "; "4. listopadu" is
 * a date, not a point), Roman points ("II. ", "IV."), letter items ("a) ",
 * "(b) "), bullets and dashes, and an indented line.
 */
export const WRAPPED_LINE_POINT_STARTS = [
  /^\(?\d{1,3}\.(?:\s+(?!\p{Ll})|$)/u,
  /^\(?\d{1,3}\)(?:\s|$)/u,
  /^\(?[IVXLC]{1,6}[.)](?:\s|$)/u,
  /^\(?\p{L}\)(?:\s|$)/u,
  /^[-–—•*·](?:\s|$)/u,
  /^\s/u,
] as const;

/**
 * Where the text of a list item starts on its first line: continuation lines
 * of the item are indented to it, which is not a paragraph's indent.
 */
export const HANGING_ITEM_MARKER_RE =
  /^(?:\d{1,3}[.)]|\p{L}[.)]|\(\d{1,3}\)|\(\p{L}\)|[-–•])[ \t]+/u;

/** The next item of a list in a typescript: a marker opening a word. */
export const LIST_ITEM_OPENING_RE =
  /^(?:\d{1,3}[.)]|\p{L}\)|\(\d{1,3}\)|\(\p{L}\)|[-–•])[ \t]+(?=\p{L})/u;

/**
 * A point numbered by outline: `2.1.`, `2.2.1`, or Word's `2.1` label. Its
 * first line hangs left of the text under it.
 */
export const OUTLINE_POINT_RE = /^\d{1,3}(?:\.\d{1,3})+\.?\s/u;

/**
 * Where a point's text starts on its first line, so the lines under it hang:
 * a number or a letter in any outline (`2.1.`, `A.`, `b)`), or a bullet.
 */
export const HANGING_POINT_MARKER_RE =
  /^(?:\d{1,3}(?:\.\d{1,3})*[.)]?|[IVXLC]{1,6}[.)]|\p{L}[.)]|[-–•])\s/u;

/** The number an authority sets before each paragraph: `(12)`, `[12]`. */
export const AUTHORITY_PARAGRAPH_NUMBER_RE = /^(?:\(\d{1,3}\)|\[\d{1,3}\])\s/u;

// parser-output-unchanged: the label shapes below moved here unchanged from cz-us, cz-nss, sk-us, pl-courts, page furniture and AST validation; a parser that reads only them keeps its output.
/** A bracketed paragraph number opening a line, and the space after it. */
export const BRACKET_PARAGRAPH_MARKER_RE = /^\[(?:\d+)\]\s*/u;

/** A word that is only a bracketed paragraph number: `[12]`. */
export const BRACKET_PARAGRAPH_MARKER_WORD_RE = /^\[\d+\]$/u;

/** A numbered paragraph's marker and the space after it: "1. ", "12. ". */
export const DOT_PARAGRAPH_MARKER_RE = /^(?:\d+)\.\s+/u;

/** A list item a section title never opens with: `2.`, `a)`, `-`. */
export const ITEM_OPENING_RE = /^(?:\d{1,3}[.)]|\p{L}\)|[-–•])\s/u;

/** A line opening with a number that numbers it: `4.`, `28.1.`. */
export const NUMBERED_LINE_RE = /^\d{1,3}(?:\.\d{1,3})*\.\s/u;

/** A line opening with a court paragraph number and a capitalised word. */
export const COURT_PARAGRAPH_OPENING_RE = /^(?<number>\d{1,3})\.\s+\p{Lu}/u;

/** A list item after a page break: `2.`, `b.`, `-`, whatever case follows. */
export const PAGE_LIST_ITEM_RE = /^\s*(?:\d{1,4}[.)]|\p{L}[.)]|[-–•])\s/u;

/** The outline number a bold subheading may open with (`2.1.`, `5.2.1.2`). */
export const SUBHEADING_OUTLINE_NUMBER_RE = /^\d{1,2}(?:\.\d{1,2}){0,4}\.? /u;

/** A heading's text without the number it opens with (`3. Odlišné …`). */
export const withoutLeadingNumber = (text: string): string =>
  text.replace(/^\d+[.)]\s*/u, "");

// ── The court's paragraph numbers ─────────────────────────

/** The three ways Czech and Slovak courts print a paragraph number. */
export const COURT_PARAGRAPH_MARKER_STYLES = [
  "bracket",
  "dot",
  "paren",
] as const;

export type CourtParagraphMarkerStyle =
  (typeof COURT_PARAGRAPH_MARKER_STYLES)[number];

/**
 * A label in a court paragraph style, read as the court's number: dates and
 * lowercase list points are excluded even after a glued marker.
 */
export const COURT_PARAGRAPH_MARKER_PATTERNS = {
  bracket: /^\[(?<number>\d{1,4})\][ \t ]*(?![ \t \d\p{Ll}])/u,
  dot: /^(?<number>\d{1,4})\.(?:[ \t ]+(?![ \t \d\p{Ll}])|(?=\p{Lu}))/u,
  paren: /^(?<number>\d{1,4})\)[ \t ]+(?![ \t \d\p{Ll}])/u,
} as const satisfies Record<CourtParagraphMarkerStyle, RegExp>;

/** The OCR'd form of a dot marker: `l.` or `I.` for `1.`. */
export const OCR_DOT_MARKER =
  /^(?<number>[\dlI]{1,4})\.(?:[ \t ]+(?![ \t \d\p{Ll}])|(?=\p{Lu}))/u;

/**
 * Whether a paragraph opens with an item marker of any shape: a court
 * marker, a list's lowercase point (`2. osoby …`), a sub-paragraph (`5.5.`),
 * a lettered point (`a) …`) or a dash. An item is not text the court's
 * numbering leaves out.
 */
export const opensWithItemLabel = (text: string): boolean => {
  const label = readPrintedLabel(text);
  return label !== null && label.kind !== PRINTED_LABEL_KIND.ROMAN;
};

// ── Dates ─────────────────────────────────────────────────

/** A numeric date ("12. 3. 1998", "1.2.1999") opening a line. */
export const NUMERIC_DATE_START_RE = /^\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}\b/u;
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
 * The genitive month names a date spells after its day, by language: a day
 * number before one of them is a date (`2. júla 2014`), never a point.
 */
const MONTH_NAMES = {
  cs: [
    "ledna",
    "února",
    "března",
    "dubna",
    "května",
    "června",
    "července",
    "srpna",
    "září",
    "října",
    "listopadu",
    "prosince",
  ],
  sk: [
    "januára",
    "februára",
    "marca",
    "apríla",
    "mája",
    "júna",
    "júla",
    "augusta",
    "septembra",
    "októbra",
    "novembra",
    "decembra",
  ],
  pl: [
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
  ],
} as const;

const MONTH_NAME_START_RE = new RegExp(
  `^(?:${[...new Set(Object.values(MONTH_NAMES).flat())].join("|")})(?![\\p{L}])`,
  "iu",
);

/** A day number (`2.`) and a month: a date, numeric or spelled out. */
const DAY_RE = /^(?:0?[1-9]|[12]\d|3[01])\.$/u;

/**
 * Whether a line opens with a date: `29. 4. 2016`, `2. júla 2014`,
 * `11. února 2015`. Its day number reads like a numbered point.
 */
export const opensWithDate = (line: string): boolean => {
  const text = line.trimStart();
  if (NUMERIC_DATE_START_RE.test(text)) {
    return true;
  }
  const label = readPrintedLabel(text);
  return (
    label?.kind === PRINTED_LABEL_KIND.NUMBER &&
    DAY_RE.test(label.marker) &&
    MONTH_NAME_START_RE.test(label.rest)
  );
};

/**
 * A numeric date a wrapper split after its day ("dňa 22." / "10. 2003"):
 * the month opens the next line like a numbered point would, but a point is
 * not introduced by "dňa" and followed by a year.
 */
export const splitsDate = (previous: string, next: string): boolean =>
  DAY_END_RE.test(previous) && MONTH_YEAR_START_RE.test(next);

// ── Where a label opens a paragraph ───────────────────────

/**
 * The words a number follows, by language: a line ending on one goes on
 * into the number that opens the next line (`písm.` / `b)`, `art.` / `5`).
 */
const NUMBER_TAKING_WORDS = {
  cs: [
    "č",
    "čl",
    "odst",
    "písm",
    "bod",
    "bodu",
    "bodě",
    "body",
    "bodech",
    "zn",
    "s",
    "str",
    "příl",
  ],
  sk: [
    "č",
    "čl",
    "ods",
    "písm",
    "pís",
    "bod",
    "bode",
    "bodu",
    "body",
    "bodoch",
    "bodov",
    "zn",
    "s",
    "str",
    "príl",
  ],
  pl: [
    "art",
    "ust",
    "pkt",
    "lit",
    "poz",
    "nr",
    "zd",
    "par",
    "rozdz",
    "tom",
    "str",
    "s",
    "k",
  ],
} as const;

const TAKES_A_NUMBER_RE = new RegExp(
  `(?:(?:^|[\\s(])(?:${[...new Set(Object.values(NUMBER_TAKING_WORDS).flat())].join("|")})\\.?|§)$`,
  "iu",
);

/** Whether a line ends on a word the number opening the next one belongs to. */
export const takesANumber = (text: string): boolean =>
  TAKES_A_NUMBER_RE.test(text.trimEnd());

/** A list item closes on a comma too: `- rozhodoval vylúčený sudca,`. */
const ENDS_ITEM_RE = /[.,;:!?…]["'“”’»)\]]*$/u;

type PrintedLabelOpensOptions = {
  /** The line above, or `undefined` at the start of a text. */
  readonly above: string | undefined;
  readonly line: string;
  /**
   * Whether the line above ran to the right margin, when the layout says.
   * A dash after a full line that closes nothing goes on a name or a range
   * (`v Praze 5` / `- Stodůlky`); a short line ended its paragraph.
   */
  readonly aboveFilled?: boolean | undefined;
};

/**
 * Whether `line` opens a paragraph with its printed label. A label opens
 * one wherever it stands, except where the line above runs into it: a date
 * wrapped after its day (`dňa` / `2. júla 2014`), a word its number belongs
 * to (`písm.` / `b)`, `v bode` / `5.5.`), or, for a dash, a full line that
 * closes nothing. Two paragraphs merged would hide the court's structure,
 * where a missed continuation only keeps a line break.
 */
export const printedLabelOpensParagraph = ({
  above,
  line,
  aboveFilled,
}: PrintedLabelOpensOptions): boolean => {
  const label = readPrintedLabel(line);
  if (label === null) {
    return false;
  }
  const previous = above?.trimEnd() ?? "";
  if (previous === "") {
    return true;
  }
  if (
    opensWithDate(line) ||
    splitsDate(previous, line.trimStart()) ||
    takesANumber(previous)
  ) {
    return false;
  }
  return !(
    label.kind === PRINTED_LABEL_KIND.BULLET &&
    aboveFilled === true &&
    !ENDS_ITEM_RE.test(previous)
  );
};
