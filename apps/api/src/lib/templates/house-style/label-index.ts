// The source document's own numbering, read into an index a cross-reference
// can be resolved against: which block is article XI, which is its paragraph
// 2, which is letter d) under that. Automatic list labels and labels typed at
// the start of a paragraph are read alike, because contracts mix both.

import { panic } from "better-result";

import {
  countedOrdinal,
  digitsValue,
  parseLabelShape,
} from "@/api/lib/templates/house-style/designators";
import type {
  DesignatorNumeral,
  LabelShape,
} from "@/api/lib/templates/house-style/designators";
import type {
  DocxBlock,
  DocxBlockManifest,
} from "@/api/lib/templates/house-style/folio-contract";

export type LabelLevel =
  "article" | "clause" | "letter" | "roman" | "annex" | "recital";

export type LabelEntry = {
  blockId: string;
  /** Position in `manifest.blocks`. */
  position: number;
  level: LabelLevel;
  /** Who prints the label: a list (`auto`), the text itself (`manual`), or
   *  a field in the text that numbers itself (`field`), whose number no
   *  text holds. */
  origin: LabelOrigin;
  shape: LabelShape;
  /** Length of a typed label and the blanks after it at the start of the
   *  block's text; 0 for an automatic label. */
  manualLength: number;
  /** The designator folded to lower case, for letters, romans and annexes. */
  core: string;
  /** An article's or an annex's counted ordinal; a clause's last component. */
  ordinal: number | null;
  /** The article this entry sits in; its own block for an article. */
  articleBlockId: string | null;
  /** That article's ordinal, also known from a dotted label (`5.1`) when no
   *  article heading was recognised. */
  articleOrdinal: number | null;
  /** A clause's number within its article: `5.1.2` is `[1, 2]`. Empty for
   *  other levels. */
  clausePath: number[];
  parentBlockId: string | null;
  /** The annex heading this entry sits under; null in the main body. */
  annexBlockId: string | null;
  /** The column the entry stands in when the document runs in parallel
   *  columns (two languages side by side); null otherwise. */
  column: number | null;
  /** An annex entry that is a line of the list of annexes, not a heading. */
  listed: boolean;
  /** An article or annex heading's title; from the next block when the
   *  heading is split over two paragraphs. */
  title: string;
  titleBlockId: string | null;
};

export type BlockContext = {
  articleBlockId: string | null;
  clauseBlockId: string | null;
  /** The innermost letter or roman item the block sits in. */
  itemBlockId: string | null;
  annexBlockId: string | null;
};

export type LabelIndex = {
  entries: readonly LabelEntry[];
  entryByBlockId: ReadonlyMap<string, LabelEntry>;
  contextByBlockId: ReadonlyMap<string, BlockContext>;
  /** The document heads its own articles with `§`, as German contracts do. */
  usesSectionSign: boolean;
  /** Paragraph blocks of a table of contents; they repeat every heading. */
  contentsBlockIds: ReadonlySet<string>;
  /** The column of each block of a document that runs in parallel columns;
   *  empty for any other document. */
  columnByBlockId: ReadonlyMap<string, number>;
  /** How long the typed label is that a heading opens with when it has no
   *  entry here because it counts the articles of a part of its own
   *  (`Article 4` of a model contract behind an agreement): the label is
   *  the heading's own name, no citation of another provision. */
  ownLabelLengths: ReadonlyMap<string, number>;
  /** Headings that name a part of the document above its articles
   *  (`IV. Short form Terms` over `4 The Buyer's obligations`); they head
   *  no article. */
  partHeadingBlockIds: ReadonlySet<string>;
};

const HEADING_TITLE_MAX = 160;
const BLANK = /^[ \t\u00A0]*/u;
const CONTENTS_STYLE =
  /^(?:toc|obsah|verzeichnis|inhaltsverzeichnis|table of contents)[ \u00A0]?\d/iu;
/** A leader tab and a page number: a contents line typed or frozen. */
const CONTENTS_LINE = /\t\d{1,4}[ \u00A0]*$/u;
const HEADING_STYLE = /heading|nadpis|überschrift|title|titul|titel/iu;
const SENTENCE_END = /[.;:,][ \u00A0]*$/u;
/** A typed keyword label followed by these words is a sentence about the
 *  provision (`Článek 5 této smlouvy se mění`), not its heading. */
const DEICTIC_START =
  /^(?:této|tohoto|těchto|smlouvy|of\b|hereof|dieses|dieser|des\b|der\b)/iu;
const ANNEX_LIST_INTRO =
  /(?:příloh|annex|schedule|appendi|exhibit|anlage|anhang|anhänge)[^.]{0,80}:[ \u00A0]*$/iu;

/** A line that heads a table of contents and says nothing else. */
const CONTENTS_CAPTION =
  /^(?:obsah|contents?|table of contents?|inhalt|inhaltsverzeichnis)[ \u00A0]*:?$/iu;

/** Whether the block is a line of the source's table of contents. */
const isContentsBlock = ({
  styleName,
  text,
}: Pick<DocxBlock, "styleName" | "text">): boolean =>
  (styleName !== null && CONTENTS_STYLE.test(styleName)) ||
  CONTENTS_LINE.test(text);

const isHeadingStyled = ({
  outlineLevel,
  styleName,
}: Pick<DocxBlock, "outlineLevel" | "styleName">): boolean =>
  outlineLevel !== null ||
  (styleName !== null && HEADING_STYLE.test(styleName));

const isTitleText = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.length <= HEADING_TITLE_MAX && !SENTENCE_END.test(trimmed);
};

const RUNNING_WORDS_MIN = 8;

/**
 * Whether the text behind a provision's label is text of its own and no
 * title: it runs past a title's length, or it ends like a sentence and is
 * long enough to be one (`Notices. Each notice is given in writing and
 * takes effect when it is received.`).
 */
export const isRunningText = (text: string): boolean => {
  const trimmed = text.replace(/^[\s:–—.-]+/u, "").trim();
  return (
    trimmed.length > HEADING_TITLE_MAX ||
    (SENTENCE_END.test(trimmed) &&
      trimmed.split(/\s+/u).length >= RUNNING_WORDS_MIN)
  );
};

type LabelOrigin = "auto" | "manual" | "field";

type RawLabel = {
  origin: LabelOrigin;
  shape: LabelShape;
  manualLength: number;
  /** The block's text after the label. */
  remainder: string;
  /** A tab, a colon, a dash or a line break sets the label off from what
   *  follows, or nothing follows: the label is not the start of a sentence. */
  separated: boolean;
};

const hasDesignator = (label: string): boolean => /[\p{L}\p{N}]/u.test(label);

const readAutoLabel = (block: DocxBlock, label: string): RawLabel | null => {
  const trimmed = label.trim();
  if (!hasDesignator(trimmed)) {
    return null;
  }
  const shape = parseLabelShape(trimmed);
  if (shape === null || shape.length !== trimmed.length) {
    return null;
  }
  return {
    origin: "auto",
    shape,
    manualLength: 0,
    remainder: block.text,
    separated: true,
  };
};

/** A month's name behind a number and a period: the day of a date
 *  (`24. Juni 2021`, `1. Januar`), not a label. Czech writes its months in
 *  lower case, which no label is followed by anyway. */
const MONTH_NAME =
  /^(?:januar|jänner|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december)(?![\p{L}])/iu;

/** What stands behind the month of a date: a year, a mark, a word in
 *  lower case, or nothing. A heading that opens with a month's name
 *  (`May Deliveries`) goes on with a capital. */
const DATE_REST =
  /^\p{L}+(?:$|\s*[,.;:)]|[ \u00A0]+(?:\d{2,4}(?!\p{L})|\p{Ll}))/u;

/** Whether the text behind a number and a period is the rest of a date,
 *  whatever blank parts the two. */
const isDateRest = (next: string): boolean =>
  MONTH_NAME.test(next) && DATE_REST.test(next);

/** A typed label is taken only when it is set off the way a label is; a
 *  sentence may open with a number (`10 dnů`, `1. ledna`). */
const isTypedLabel = (shape: LabelShape, after: string): boolean => {
  if (shape.keyword !== null) {
    return /^(?:$|[\s:–—-])/u.test(after);
  }
  // A roman numeral alone on its line heads an article whose title follows
  // in the next paragraph.
  const counted =
    shape.numeral === "upperRoman" || shape.numeral === "upperAmbiguous";
  if (counted && shape.period && after.trim() === "") {
    return true;
  }
  const blank = BLANK.exec(after)?.[0] ?? "";
  if (blank === "") {
    return false;
  }
  const next = after.slice(blank.length);
  if (next === "") {
    return false;
  }
  if (shape.numeral === "decimal") {
    const dotted = (shape.path?.length ?? 0) > 1;
    const bracketed = shape.close !== "";
    if (dotted || bracketed) {
      return true;
    }
    // The day of a date is no label, behind a blank or behind a tab.
    if (shape.period && isDateRest(next)) {
      return false;
    }
    return blank.includes("\t") || (shape.period && !/^\p{Ll}/u.test(next));
  }
  if (shape.numeral === "upperRoman" || shape.numeral === "upperAmbiguous") {
    return shape.period || shape.close !== "";
  }
  if (shape.numeral === "upperLetter") {
    return shape.close !== "" || (shape.period && blank.includes("\t"));
  }
  return shape.close !== "";
};

const readManualLabel = (block: DocxBlock): RawLabel | null => {
  const lead = BLANK.exec(block.text)?.[0].length ?? 0;
  const body = block.text.slice(lead);
  const shape = parseLabelShape(body);
  if (shape === null) {
    return null;
  }
  const after = body.slice(shape.length);
  if (!isTypedLabel(shape, after)) {
    return null;
  }
  const blank = BLANK.exec(after)?.[0] ?? "";
  const remainder = after.slice(blank.length);
  return {
    origin: "manual",
    shape,
    manualLength: lead + shape.length + blank.length,
    remainder,
    separated: blank.includes("\t") || /^(?:$|[\n:–—-])/u.test(remainder),
  };
};

/**
 * The label a list prints in front of a paragraph. Null for a paragraph in
 * no list, and for one whose list level prints nothing: a heading style
 * bound to a list for its outline only reads like any unnumbered paragraph,
 * typed label and all.
 */
export const printedLabel = ({
  label,
}: Pick<DocxBlock, "label">): string | null =>
  label === null || label.trim() === "" ? null : label;

/** What stands in front of the number of an annex a field counts: the
 *  annex's name, with the word for "number" some write behind it. */
const FIELD_ANNEX_LEAD =
  /^[ \u00A0]*(?:příloha|annex|schedule|appendix|exhibit|anlage|anhang)(?:[ \u00A0]+(?:č\.|no\.|nr\.))?[ \u00A0]*$/iu;

/**
 * The label of an annex heading whose number a field counts (`Příloha č.
 * <n> Název`): the text holds the name alone, so the number is the one the
 * heading has among the document's headings of this kind.
 */
const readFieldLabel = (block: DocxBlock, ordinal: number): RawLabel | null => {
  const at = block.selfNumbers?.at(0);
  // A line of the contents names a heading; it is none.
  if (
    block.kind !== "paragraph" ||
    at === undefined ||
    isContentsBlock(block)
  ) {
    return null;
  }
  const lead = block.text.slice(0, at);
  if (!FIELD_ANNEX_LEAD.test(lead)) {
    return null;
  }
  const shape = parseLabelShape(`${lead.trim()} ${String(ordinal)}`);
  if (shape?.keyword !== "annex") {
    return null;
  }
  const after = block.text.slice(at);
  const blank = BLANK.exec(after)?.[0] ?? "";
  return {
    origin: "field",
    shape,
    manualLength: at + blank.length,
    remainder: after.slice(blank.length),
    separated: true,
  };
};

const readLabel = (block: DocxBlock): RawLabel | null => {
  // A bullet's mark is no designator, even when it is a letter (a font's
  // `o` for the second level of a bulleted list).
  if (
    block.kind !== "paragraph" ||
    isContentsBlock(block) ||
    block.numbering?.bullet === true
  ) {
    return null;
  }
  const label = printedLabel(block);
  return label === null ? readManualLabel(block) : readAutoLabel(block, label);
};

/** A heading states a title or nothing; a sentence that opens with a
 *  provision's name runs on. */
const isHeadingRemainder = (remainder: string): boolean => {
  const title = remainder.replace(/^[\s:–—-]+/u, "");
  return isTitleText(title) && !DEICTIC_START.test(title);
};

const titleOf = (remainder: string): string =>
  remainder.replace(/^[\s:–—.-]+/u, "").trim();

type NumeralFamily = "roman" | "letter";

const familyOf = (numeral: DesignatorNumeral): NumeralFamily | null => {
  switch (numeral) {
    case "upperRoman":
    case "lowerRoman":
      return "roman";
    case "upperLetter":
    case "lowerLetter":
      return "letter";
    case "decimal":
    case "upperAmbiguous":
    case "lowerAmbiguous":
      return null;
    default: {
      numeral satisfies never;
      return panic("Unhandled numeral");
    }
  }
};

const isAmbiguous = (numeral: DesignatorNumeral): boolean =>
  numeral === "upperAmbiguous" || numeral === "lowerAmbiguous";

type ListMemory = { core: string; family: NumeralFamily };

/** `i` after `h` is a letter, `v` after `iv` is a numeral, and a list that
 *  opens with `i` counts in numerals. */
const ambiguousFamily = (
  previous: ListMemory | undefined,
  core: string,
): NumeralFamily => {
  const followsLetter =
    previous?.family === "letter" &&
    previous.core.length === 1 &&
    (previous.core.codePointAt(0) ?? 0) + 1 === core.codePointAt(0);
  if (followsLetter) {
    return "letter";
  }
  return previous?.family === "roman" || core === "i" ? "roman" : "letter";
};

/** Decides the single characters that are both a letter and a roman numeral
 *  by the list they stand in. Null for a decimal label. */
const resolveFamilies = (
  blocks: readonly DocxBlock[],
  raws: readonly (RawLabel | null)[],
): (NumeralFamily | null)[] => {
  const previousByList = new Map<string, ListMemory>();
  return raws.map((raw, position) => {
    if (raw === null) {
      return null;
    }
    const { numeral, open, close } = raw.shape;
    const known = familyOf(numeral);
    if (known === null && !isAmbiguous(numeral)) {
      // A numbered clause ends the typed lists of items before it: `i)`
      // after it opens a new list, whatever letter the last one stopped at.
      // Roman headings (`IX.`, `X.`) run on across the clauses between.
      if (open === "" && close === "") {
        for (const key of [...previousByList.keys()]) {
          if (key.startsWith("typed:lower:")) {
            previousByList.delete(key);
          }
        }
      }
      return null;
    }
    const numbering = blocks[position]?.numbering ?? null;
    const listKey =
      numbering === null
        ? `typed:${numeral.startsWith("upper") ? "upper" : "lower"}:${open}${close}`
        : `auto:${String(numbering.numId)}:${String(numbering.ilvl)}`;
    const core = raw.shape.core.toLowerCase();
    const family = known ?? ambiguousFamily(previousByList.get(listKey), core);
    previousByList.set(listKey, { core, family });
    return family;
  });
};

/** One block of the walk: its place, and its label when it has one. */
type Row = {
  block: DocxBlock;
  position: number;
  raw: RawLabel | null;
  family: NumeralFamily | null;
};

type LabelledRow = Row & { raw: RawLabel };

type Scheme = {
  /** Articles carry a keyword or a roman numeral of their own. */
  namedArticles: boolean;
  /** Clauses carry dotted numbers, so a bare `5.` heads article 5. */
  dotted: boolean;
};

type Walk = {
  rows: readonly Row[];
  /** The main body and the annexes number on their own. */
  schemes: { body: Scheme; annexes: Scheme };
  /** Positions of annex lines that name an annex without opening it. */
  listedAnnexes: ReadonlySet<number>;
  /** Positions of typed article headings that head no article of the
   *  document's own numbering. */
  articleMentions: ReadonlySet<number>;
  /** Positions of numbered list items that only list the headings. */
  listedHeadings: ReadonlySet<number>;
  /** Positions of headings over the articles (the parts of a pack: order
   *  form, terms, annexes), which head no article. */
  partHeadings: ReadonlySet<number>;
  article: LabelEntry | null;
  clauses: LabelEntry[];
  letter: LabelEntry | null;
  roman: LabelEntry | null;
  annex: LabelEntry | null;
  sawArticle: boolean;
  usesSectionSign: boolean;
  /** The parallel column this walk reads; null for the main story. */
  column: number | null;
};

const isLabelled = (row: Row): row is LabelledRow => row.raw !== null;

const isUpperCase = ({ shape }: RawLabel): boolean =>
  shape.core === shape.core.toUpperCase();

const isNamedArticle = ({ block, raw, family }: LabelledRow): boolean => {
  const { keyword } = raw.shape;
  if (keyword === "article" || keyword === "sectionSign") {
    return raw.origin !== "manual" || isHeadingRemainder(raw.remainder);
  }
  const counted = family === "roman" && isUpperCase(raw) && keyword === null;
  if (!counted || !raw.shape.period) {
    return false;
  }
  return raw.origin === "auto"
    ? isHeadingStyled(block) || isTitleText(block.text)
    : isHeadingRemainder(raw.remainder);
};

const samePath = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const nextTitleBlock = (
  rows: readonly Row[],
  position: number,
): DocxBlock | null => {
  const next = rows[position + 1];
  if (
    next === undefined ||
    next.raw !== null ||
    next.block.kind !== "paragraph" ||
    printedLabel(next.block) !== null ||
    next.block.text.trim() === "" ||
    !isTitleText(next.block.text) ||
    isContentsBlock(next.block)
  ) {
    return null;
  }
  return next.block;
};

const previousText = (rows: readonly Row[], position: number): string => {
  for (let index = position - 1; index >= 0; index -= 1) {
    const text = rows[index]?.block.text ?? "";
    if (text.trim() !== "") {
      return text;
    }
  }
  return "";
};

const isAnnexRow = (row: Row | undefined): row is LabelledRow =>
  row !== undefined &&
  isLabelled(row) &&
  row.raw.shape.keyword === "annex" &&
  // A line of the list of annexes may run long and end in a semicolon; set
  // off from its caption, it is still no sentence about the annex.
  (row.raw.separated || isHeadingRemainder(row.raw.remainder));

/** Lines of the list of annexes stand together or under a sentence that
 *  announces them; a heading stands alone. */
const isAnnexListLine = (rows: readonly Row[], position: number): boolean =>
  isAnnexRow(rows[position - 1]) ||
  isAnnexRow(rows[position + 1]) ||
  ANNEX_LIST_INTRO.test(previousText(rows, position));

const schemeOf = (scope: readonly LabelledRow[]): Scheme => ({
  namedArticles: scope.some(isNamedArticle),
  dotted: scope.some(({ raw }) => (raw.shape.path?.length ?? 0) > 1),
});

/** Whether a bare number heads an article under the scheme: `5.` where the
 *  clauses are `5.1`, or a numbered heading where nothing else names
 *  articles. */
const headsArticle = (scheme: Scheme, { block, raw }: LabelledRow): boolean =>
  raw.shape.keyword === null &&
  raw.shape.path?.length === 1 &&
  raw.shape.close === "" &&
  !scheme.namedArticles &&
  (scheme.dotted || isHeadingStyled(block));

/** Before the annexes are told apart, a named article anywhere must not hide
 *  the bare numbers that head the main body's articles. */
const numberedScheme = (labelled: readonly LabelledRow[]): Scheme => ({
  namedArticles: false,
  dotted: schemeOf(labelled).dotted,
});

/**
 * The ordinals of articles headed beyond doubt: an automatic label on a
 * paragraph with an outline level, which is what Word calls a heading.
 */
const numberedArticleOrdinals = (
  labelled: readonly LabelledRow[],
): Set<number> => {
  const scheme = numberedScheme(labelled);
  const ordinals = new Set<number>();
  for (const row of labelled) {
    if (row.raw.origin !== "auto" || row.block.outlineLevel === null) {
      continue;
    }
    const named = isNamedArticle(row)
      ? countedOrdinal(row.raw.shape.core)
      : null;
    const bare = headsArticle(scheme, row) ? row.raw.shape.path?.at(0) : null;
    const ordinal = named ?? bare ?? null;
    if (ordinal !== null) {
      ordinals.add(ordinal);
    }
  }
  return ordinals;
};

/** Bare numbered headings it takes to show that bare numbers head the
 *  articles. */
const NUMBERED_HEADINGS_MIN = 2;

/**
 * Headings above the articles: roman-numbered headings (`IV. Short form
 * Terms`) at a higher outline level than automatic bare numbers that head
 * articles of their own (`4 The Buyer's obligations` over `4.1`). Such a
 * heading names a part of the document, not an article; the articles are
 * the bare numbers under it. Empty where no bare numbers head at a lower
 * level, as in a contract whose roman articles hold numbered clauses.
 */
const partHeadingPositions = (
  labelled: readonly LabelledRow[],
): Set<number> => {
  const bareLevels = labelled.flatMap(({ raw, block }) =>
    raw.origin === "auto" &&
    raw.shape.keyword === null &&
    raw.shape.path?.length === 1 &&
    raw.shape.close === "" &&
    block.outlineLevel !== null
      ? [block.outlineLevel]
      : [],
  );
  if (bareLevels.length < NUMBERED_HEADINGS_MIN) {
    return new Set();
  }
  const articleLevel = Math.min(...bareLevels);
  return new Set(
    labelled
      .filter(
        (row) =>
          row.raw.shape.keyword === null &&
          isNamedArticle(row) &&
          row.block.outlineLevel !== null &&
          row.block.outlineLevel < articleLevel,
      )
      .map(({ position }) => position),
  );
};

/** A list of headings runs at least this long without text between. */
const HEADING_LIST_MIN = 3;

/**
 * The lines of a numbered list of headings: a contents list typed as an
 * automatic list. An article has text under it and is headed once, so a
 * run of bare numbers with nothing between them, whose numbers head
 * articles again further on, lists those articles.
 */
const listedHeadingPositions = (
  labelled: readonly LabelledRow[],
): Set<number> => {
  const scheme = numberedScheme(labelled);
  const heads = labelled.filter(
    (row) => row.raw.origin === "auto" && headsArticle(scheme, row),
  );
  const listed = new Set<number>();
  let run: LabelledRow[] = [];
  const close = () => {
    const last = run.at(-1);
    if (last !== undefined && run.length >= HEADING_LIST_MIN) {
      const later = new Set(
        heads
          .filter(({ position }) => position > last.position)
          .map(({ raw }) => raw.shape.path?.at(0)),
      );
      for (const row of run) {
        if (later.has(row.raw.shape.path?.at(0))) {
          listed.add(row.position);
        }
      }
    }
    run = [];
  };
  for (const row of heads) {
    const previous = run.at(-1);
    const continues =
      previous !== undefined &&
      previous.position + 1 === row.position &&
      previous.block.numbering?.numId === row.block.numbering?.numId;
    if (!continues) {
      close();
    }
    run.push(row);
  }
  close();
  return listed;
};

/**
 * An article is headed once. Where the automatic numbering already heads
 * it, a typed `Clause 6 Data Protection` (a line of a summary table, say)
 * refers to that article.
 */
const isArticleMention = (
  numberedArticles: ReadonlySet<number>,
  row: LabelledRow,
): boolean => {
  // `Clause 4.20 Updating Contact Details` names a clause of article 4.
  const { core, path } = row.raw.shape;
  const ordinal = countedOrdinal(core) ?? path?.at(0) ?? null;
  return (
    row.raw.origin === "manual" &&
    ordinal !== null &&
    numberedArticles.has(ordinal) &&
    isNamedArticle(row)
  );
};

/**
 * The positions of the typed article headings that head no article of the
 * document's own numbering. A mention is one; so is every heading that
 * counts on from it (`Article 4` behind a mentioned `Article 3`): a part
 * that counts its own articles (a model contract in an annex) is one run,
 * and its later headings are no more the document's articles than its
 * first ones, whose numbers the document's own articles happen to take.
 */
const articleMentionPositions = (
  numberedArticles: ReadonlySet<number>,
  labelled: readonly LabelledRow[],
): { mentions: Set<number>; countedOn: Set<number> } => {
  const mentions = new Set<number>();
  /** The headings that are here only because they count on, by ordinal. */
  const countedOn = new Map<number, number>();
  const scheme = numberedScheme(labelled);
  const typed: { position: number; ordinal: number | null }[] = [];
  /** The ordinal of the typed article heading read last, when it was one
   *  of these. */
  let counted: number | null = null;
  for (const row of labelled) {
    // An article of the document's own numbering ends such a run: a typed
    // heading behind it counts on from nothing.
    if (
      row.raw.origin === "auto" &&
      row.block.outlineLevel !== null &&
      (isNamedArticle(row) || headsArticle(scheme, row))
    ) {
      counted = null;
      continue;
    }
    if (row.raw.origin !== "manual" || !isNamedArticle(row)) {
      continue;
    }
    const { core, path } = row.raw.shape;
    const ordinal = countedOrdinal(core) ?? path?.at(0) ?? null;
    const heads = path === null || path.length <= 1;
    if (heads) {
      typed.push({ position: row.position, ordinal });
    }
    const mentioned = isArticleMention(numberedArticles, row);
    if (mentioned || (heads && counted !== null && ordinal === counted + 1)) {
      mentions.add(row.position);
      if (!mentioned && ordinal !== null) {
        countedOn.set(row.position, ordinal);
      }
      // A clause of such an article (`Article 4.2`) counts nothing on.
      counted = heads ? ordinal : counted;
    } else {
      counted = null;
    }
  }
  // Where the document has a typed article of that number of its own, the
  // heading stays in the index beside it: a citation of the number then
  // has two places it may mean and is linked to neither, instead of being
  // linked to the one that happened to be left.
  for (const [position, ordinal] of countedOn) {
    if (
      typed.some(
        (other) => other.ordinal === ordinal && !mentions.has(other.position),
      )
    ) {
      mentions.delete(position);
    }
  }
  return {
    mentions,
    countedOn: new Set(
      [...countedOn.keys()].filter((position) => mentions.has(position)),
    ),
  };
};

/**
 * The annex lines that only name an annex: the list of annexes, and any
 * line in front of the first article. Annexes follow the articles, so an
 * annex named on a cover page or in a guidance note is not the annex, and
 * a document that is itself an annex numbers its own main body.
 */
const listedAnnexPositions = (
  rows: readonly Row[],
  labelled: readonly LabelledRow[],
): Set<number> => {
  const numbered = numberedScheme(labelled);
  const firstArticle =
    labelled.find((row) => isNamedArticle(row) || headsArticle(numbered, row))
      ?.position ?? -1;
  return new Set(
    labelled
      .filter(
        (row) =>
          isAnnexRow(row) &&
          (row.position < firstArticle || isAnnexListLine(rows, row.position)),
      )
      .map(({ position }) => position),
  );
};

type EntryBase = Pick<
  LabelEntry,
  | "blockId"
  | "position"
  | "origin"
  | "shape"
  | "manualLength"
  | "core"
  | "annexBlockId"
  | "column"
  | "listed"
  | "title"
  | "titleBlockId"
>;

const baseEntry = (
  walk: Walk,
  { block, position, raw }: LabelledRow,
): EntryBase => ({
  blockId: block.id,
  position,
  origin: raw.origin,
  shape: raw.shape,
  manualLength: raw.manualLength,
  core: raw.shape.core.toLowerCase(),
  annexBlockId: walk.annex?.blockId ?? null,
  column: walk.column,
  listed: false,
  title: "",
  titleBlockId: null,
});

const headingTitle = (
  rows: readonly Row[],
  { position, raw }: LabelledRow,
): Pick<LabelEntry, "title" | "titleBlockId"> => {
  const own = titleOf(raw.remainder);
  if (own !== "") {
    return { title: own, titleBlockId: null };
  }
  const next = nextTitleBlock(rows, position);
  return next === null
    ? { title: "", titleBlockId: null }
    : { title: next.text.trim(), titleBlockId: next.id };
};

const closeProvisions = (walk: Walk): void => {
  walk.clauses = [];
  walk.letter = null;
  walk.roman = null;
};

const openArticle = (
  walk: Walk,
  row: LabelledRow,
  ordinal: number | null,
): LabelEntry => {
  const entry: LabelEntry = {
    ...baseEntry(walk, row),
    ...headingTitle(walk.rows, row),
    level: "article",
    ordinal,
    articleBlockId: row.block.id,
    articleOrdinal: ordinal,
    clausePath: [],
    parentBlockId: null,
  };
  walk.article = entry;
  closeProvisions(walk);
  walk.sawArticle = true;
  walk.usesSectionSign ||= row.raw.shape.keyword === "sectionSign";
  return entry;
};

type ClausePlace = {
  /** The clause's number within its article. */
  path: number[];
  /** The article a dotted label names; null for a label that names none. */
  articleOrdinal: number | null;
};

const openClause = (
  walk: Walk,
  row: LabelledRow,
  { path, articleOrdinal }: ClausePlace,
): LabelEntry => {
  // A dotted label names its article; an article heading that was not
  // recognised must not lend the previous article's block.
  const article =
    walk.article !== null &&
    (articleOrdinal === null || walk.article.ordinal === articleOrdinal)
      ? walk.article
      : null;
  walk.article = article;
  const ordinal = article?.ordinal ?? articleOrdinal;
  walk.clauses = walk.clauses.filter(
    (open) =>
      open.clausePath.length < path.length &&
      open.articleOrdinal === ordinal &&
      samePath(open.clausePath, path.slice(0, open.clausePath.length)),
  );
  const entry: LabelEntry = {
    ...baseEntry(walk, row),
    level: "clause",
    ordinal: path.at(-1) ?? null,
    articleBlockId: article?.blockId ?? null,
    articleOrdinal: ordinal,
    clausePath: path,
    parentBlockId: walk.clauses.at(-1)?.blockId ?? article?.blockId ?? null,
  };
  walk.clauses.push(entry);
  walk.letter = null;
  walk.roman = null;
  return entry;
};

const openItem = (
  walk: Walk,
  row: LabelledRow,
  level: "letter" | "roman",
): LabelEntry => {
  const clause = walk.clauses.at(-1) ?? null;
  const parent =
    level === "roman"
      ? (walk.letter ?? clause ?? walk.article)
      : (clause ?? walk.article);
  const entry: LabelEntry = {
    ...baseEntry(walk, row),
    level,
    ordinal: null,
    articleBlockId: walk.article?.blockId ?? null,
    articleOrdinal: walk.article?.ordinal ?? clause?.articleOrdinal ?? null,
    clausePath: [],
    parentBlockId: parent?.blockId ?? null,
  };
  if (level === "letter") {
    walk.letter = entry;
    walk.roman = null;
  } else {
    walk.roman = entry;
  }
  return entry;
};

const openAnnex = (walk: Walk, row: LabelledRow): LabelEntry => {
  const listed = walk.listedAnnexes.has(row.position);
  const entry: LabelEntry = {
    ...baseEntry(walk, row),
    ...headingTitle(walk.rows, row),
    level: "annex",
    ordinal: countedOrdinal(row.raw.shape.core),
    articleBlockId: null,
    articleOrdinal: null,
    clausePath: [],
    parentBlockId: null,
    annexBlockId: null,
    listed,
  };
  // A heading opens the annex's own numbering; a line of the list does not.
  if (!listed) {
    walk.annex = entry;
    walk.article = null;
    closeProvisions(walk);
  }
  return entry;
};

const openNumbered = (
  walk: Walk,
  row: LabelledRow,
  path: readonly number[],
): LabelEntry | null => {
  const [first, ...rest] = path;
  if (first === undefined) {
    return null;
  }
  const scheme = walk.annex === null ? walk.schemes.body : walk.schemes.annexes;
  if (rest.length === 0) {
    if (!headsArticle(scheme, row)) {
      return openClause(walk, row, { path: [first], articleOrdinal: null });
    }
    return walk.listedHeadings.has(row.position)
      ? null
      : openArticle(walk, row, first);
  }
  // Under a named article whose clauses are labelled `1.`, `2.`, the label
  // `1.1` is the first sub-clause of clause 1, not a clause of article 1.
  const outer = walk.clauses.at(0);
  const relative =
    walk.article !== null &&
    scheme.namedArticles &&
    outer?.shape.path?.length === 1 &&
    outer.clausePath.at(0) === first;
  return relative
    ? openClause(walk, row, { path: [...path], articleOrdinal: null })
    : openClause(walk, row, { path: rest, articleOrdinal: first });
};

const classify = (walk: Walk, row: LabelledRow): LabelEntry | null => {
  const { shape } = row.raw;
  if (shape.keyword === "annex") {
    return isAnnexRow(row) ? openAnnex(walk, row) : null;
  }
  if (walk.partHeadings.has(row.position)) {
    return null;
  }
  if (isNamedArticle(row)) {
    if (walk.annex === null && walk.articleMentions.has(row.position)) {
      return null;
    }
    // A keyword over a dotted number (`Article 5.1 Fees`) heads a clause of
    // its article, not an article of its own.
    return shape.path !== null && shape.path.length > 1
      ? openNumbered(walk, row, shape.path)
      : openArticle(walk, row, countedOrdinal(shape.core));
  }
  if (shape.keyword !== null) {
    return null;
  }
  if (shape.path !== null) {
    return openNumbered(walk, row, shape.path);
  }
  if (row.family === null || (row.family === "roman" && isUpperCase(row.raw))) {
    return null;
  }
  // Capital letters in front of the first article are recitals.
  if (
    row.family === "letter" &&
    isUpperCase(row.raw) &&
    !walk.sawArticle &&
    walk.annex === null
  ) {
    return {
      ...baseEntry(walk, row),
      level: "recital",
      ordinal: null,
      articleBlockId: null,
      articleOrdinal: null,
      clausePath: [],
      parentBlockId: null,
    };
  }
  return openItem(walk, row, row.family);
};

/** Two columns of a table must repeat this many labels to count as parallel. */
const PARALLEL_LABELS_MIN = 2;

/**
 * The column of every table-cell block when the document runs in parallel
 * columns: a contract in two languages side by side, where the cells of a
 * row carry the same provisions under the same labels. Each column is then
 * read as a text of its own. Empty when no table repeats its labels across
 * columns, so price tables and signature tables stay part of the one main
 * story.
 */
const parallelColumns = (
  blocks: readonly DocxBlock[],
  structural: readonly LabelledRow[],
): Map<string, number> => {
  const columnByBlockId = new Map<string, number>();
  const tableByBlockId = new Map<string, string>();
  for (const { id, cells } of blocks) {
    if (cells === undefined) {
      continue;
    }
    for (const { col, blockIds } of cells) {
      for (const blockId of blockIds) {
        columnByBlockId.set(blockId, col);
        tableByBlockId.set(blockId, id);
      }
    }
  }
  // Per table and label, the columns that carry it.
  const columnsByLabel = new Map<string, Set<number>>();
  for (const { block, raw } of structural) {
    const column = columnByBlockId.get(block.id);
    const table = tableByBlockId.get(block.id);
    if (column === undefined || table === undefined) {
      continue;
    }
    const { open, core, close } = raw.shape;
    const label = `${table}\u0000${open}${core.toLowerCase()}${close}`;
    const columns = columnsByLabel.get(label);
    if (columns === undefined) {
      columnsByLabel.set(label, new Set([column]));
    } else {
      columns.add(column);
    }
  }
  const repeated = [...columnsByLabel.values()].filter(
    (columns) => columns.size > 1,
  ).length;
  return repeated >= PARALLEL_LABELS_MIN
    ? columnByBlockId
    : new Map<string, number>();
};

/** The second part of a number typed apart from its first: `1. 1. Text`
 *  behind the label `1.`. */
const SPACED_SECOND = /^(?<second>\d{1,3})\.(?<blank>[ \t\u00A0]+)(?=\S)/u;
/** What a provision's text opens with; a year or a month's name does not. */
const OPENS_TEXT = /^[\p{Lu}„“"‚'([]/u;

type SpacedNumber = { position: number; second: number; joined: RawLabel };

/** A typed `1.` whose text goes on with a second number and a provision's
 *  text: read as one number, should its run prove it. */
const readSpacedNumber = (
  block: DocxBlock,
  raw: RawLabel,
  position: number,
): SpacedNumber | null => {
  const { shape } = raw;
  const first = shape.path?.length === 1 ? shape.path.at(0) : undefined;
  const match = SPACED_SECOND.exec(raw.remainder);
  const digits = match?.groups?.["second"] ?? "";
  const second = digitsValue(digits);
  if (
    raw.origin !== "manual" ||
    shape.keyword !== null ||
    shape.numeral !== "decimal" ||
    !shape.period ||
    shape.open !== "" ||
    shape.close !== "" ||
    first === undefined ||
    match === null ||
    second === null
  ) {
    return null;
  }
  const rest = raw.remainder.slice(match[0].length);
  const lead = BLANK.exec(block.text)?.[0].length ?? 0;
  const between = raw.manualLength - lead - shape.length;
  const literal = block.text.slice(
    lead,
    // As many digits as are typed: `01` is two.
    raw.manualLength + digits.length + 1,
  );
  const whole = parseLabelShape(`${String(first)}.${String(second)}.`);
  // Blanks only part the two numbers: a tab sets a label off from text.
  if (
    whole === null ||
    !OPENS_TEXT.test(rest) ||
    !/^[ \u00A0]+$/u.test(
      block.text.slice(lead + shape.length, lead + shape.length + between),
    )
  ) {
    return null;
  }
  const blank = match.groups?.["blank"] ?? "";
  return {
    position,
    second,
    joined: {
      origin: "manual",
      shape: { ...whole, length: literal.length },
      manualLength: lead + literal.length + blank.length,
      remainder: rest,
      separated: blank.includes("\t"),
    },
  };
};

/** The number of the article a row heads, as far as a row tells before the
 *  entries are nested: a single number, or an article's name and number. */
const headedNumber = ({ shape }: RawLabel): number | null => {
  if (shape.numeral !== "decimal") {
    return null;
  }
  if (shape.keyword === "article" || shape.keyword === "sectionSign") {
    return countedOrdinal(shape.core);
  }
  return shape.keyword === null && shape.path?.length === 1
    ? (shape.path.at(0) ?? null)
    : null;
};

/**
 * Reads `1. 1.`, `1. 2.` under article 1 as `1.1.`, `1.2.`: a number typed
 * with a blank between its parts. Only a run proves it: the first number is
 * the number of the article above, and the second numbers count 1, 2, 3
 * without a gap over two paragraphs or more. One such paragraph alone, a
 * day and a month (`1. 1. 2026`), a number in front of a word in lower case
 * stay what they were read as. Each column of a table counts for itself:
 * two language versions side by side are two runs, not one that counts
 * every number twice.
 */
const joinSpacedNumbers = (
  blocks: readonly DocxBlock[],
  raws: (RawLabel | null)[],
): void => {
  const columnOf = new Map<string, number>();
  for (const { cells } of blocks) {
    if (cells === undefined) {
      continue;
    }
    for (const { col, blockIds } of cells) {
      for (const blockId of blockIds) {
        columnOf.set(blockId, col);
      }
    }
  }
  type Counting = { article: number | null; run: SpacedNumber[] };
  /** What is counted outside tables, and in each column of them. */
  const countings = new Map<number | null, Counting>();
  const close = (counting: Counting) => {
    const counted = counting.run.every(({ second }, at) => second === at + 1);
    if (counting.run.length > 1 && counted) {
      for (const { position, joined } of counting.run) {
        raws[position] = joined;
      }
    }
    counting.run = [];
  };
  for (const [position, raw] of raws.entries()) {
    const block = blocks[position];
    if (raw === null || block === undefined) {
      continue;
    }
    const column = columnOf.get(block.id) ?? null;
    // A column counts under the heading that spans the columns above it.
    const counting = countings.get(column) ?? {
      article: countings.get(null)?.article ?? null,
      run: [],
    };
    countings.set(column, counting);
    const spaced = readSpacedNumber(block, raw, position);
    if (spaced !== null && raw.shape.path?.at(0) === counting.article) {
      counting.run.push(spaced);
      continue;
    }
    const headed = headedNumber(raw);
    if (headed !== null || raw.shape.keyword !== null) {
      // A heading outside the columns heads every column from there on.
      for (const under of column === null ? countings.values() : [counting]) {
        close(under);
        under.article = headed;
      }
    }
  }
  for (const counting of countings.values()) {
    close(counting);
  }
};

/** Reads every paragraph's label and nests the entries. */
export const buildLabelIndex = ({
  blocks,
}: Pick<DocxBlockManifest, "blocks">): LabelIndex => {
  // An annex a field numbers is counted here: its text holds no number.
  let fieldAnnexes = 0;
  const raws = blocks.map((block) => {
    const read = readLabel(block);
    if (read !== null) {
      return read;
    }
    const counted = readFieldLabel(block, fieldAnnexes + 1);
    fieldAnnexes += counted === null ? 0 : 1;
    return counted;
  });
  joinSpacedNumbers(blocks, raws);
  const families = resolveFamilies(blocks, raws);
  const rows = blocks.map((block, position): Row => ({
    block,
    position,
    raw: raws[position] ?? null,
    family: families[position] ?? null,
  }));
  const labelled = rows.filter(isLabelled);
  const numberedArticles = numberedArticleOrdinals(labelled);
  const listedHeadings = listedHeadingPositions(labelled);
  const { mentions: articleMentions, countedOn } = articleMentionPositions(
    numberedArticles,
    labelled,
  );
  // Mentions say nothing about how the document numbers itself. A heading
  // that only counts on from one still says how its part is numbered: it
  // stays among the rows the schemes are read from.
  const partHeadings = partHeadingPositions(labelled);
  const structural = labelled.filter(
    (row) =>
      !isArticleMention(numberedArticles, row) &&
      !partHeadings.has(row.position),
  );
  const listedAnnexes = listedAnnexPositions(rows, structural);
  const firstAnnex =
    structural.find(
      (row) => isAnnexRow(row) && !listedAnnexes.has(row.position),
    )?.position ?? Number.POSITIVE_INFINITY;
  const schemes = {
    body: schemeOf(structural.filter(({ position }) => position < firstAnnex)),
    annexes: schemeOf(
      structural.filter(({ position }) => position > firstAnnex),
    ),
  };
  const columnByBlockId = parallelColumns(blocks, structural);
  // One walk per parallel column, and one for everything outside them.
  const walks = new Map<number | null, Walk>();
  const walkOf = (block: DocxBlock): Walk => {
    const column = columnByBlockId.get(block.id) ?? null;
    const open = walks.get(column);
    if (open !== undefined) {
      return open;
    }
    // A column starts under whatever heading spans the columns above it.
    const spanning = walks.get(null);
    const opened: Walk = {
      rows,
      listedAnnexes,
      articleMentions,
      listedHeadings,
      partHeadings,
      schemes,
      article: spanning?.article ?? null,
      clauses: [],
      letter: null,
      roman: null,
      annex: spanning?.annex ?? null,
      sawArticle: spanning?.sawArticle ?? false,
      usesSectionSign: false,
      column,
    };
    walks.set(column, opened);
    return opened;
  };

  const entries: LabelEntry[] = [];
  const contextByBlockId = new Map<string, BlockContext>();
  const contentsBlockIds = new Set<string>();
  /** The last paragraph with text in front of the row, while it may be the
   *  caption of the contents that follow. */
  let caption: DocxBlock | null = null;
  for (const row of rows) {
    const { block } = row;
    if (block.kind === "paragraph" && isContentsBlock(block)) {
      contentsBlockIds.add(block.id);
      // The caption goes with the lines it heads: alone it heads nothing.
      if (caption !== null && CONTENTS_CAPTION.test(caption.text.trim())) {
        contentsBlockIds.add(caption.id);
      }
      caption = null;
    } else if (block.kind !== "paragraph") {
      caption = null;
    } else if (block.text.trim() !== "") {
      caption = block;
    }
    const walk = walkOf(block);
    const entry = isLabelled(row) ? classify(walk, row) : null;
    if (entry !== null) {
      entries.push(entry);
    }
    // A heading outside the columns (`§ 3` over a row of two languages)
    // heads every column.
    const spans =
      walk.column === null &&
      entry !== null &&
      (entry.level === "article" || (entry.level === "annex" && !entry.listed));
    if (spans) {
      for (const column of walks.values()) {
        if (column !== walk) {
          column.article = walk.article;
          column.annex = walk.annex;
          column.sawArticle = true;
          closeProvisions(column);
        }
      }
    }
    contextByBlockId.set(block.id, {
      articleBlockId: walk.article?.blockId ?? null,
      clauseBlockId: walk.clauses.at(-1)?.blockId ?? null,
      itemBlockId: walk.roman?.blockId ?? walk.letter?.blockId ?? null,
      annexBlockId: walk.annex?.blockId ?? null,
    });
  }

  return {
    entries,
    entryByBlockId: new Map(entries.map((entry) => [entry.blockId, entry])),
    contextByBlockId,
    usesSectionSign: [...walks.values()].some(
      ({ usesSectionSign }) => usesSectionSign,
    ),
    contentsBlockIds,
    columnByBlockId,
    ownLabelLengths: new Map(
      labelled
        .filter(
          ({ position, block }) =>
            countedOn.has(position) &&
            !entries.some(({ blockId }) => blockId === block.id),
        )
        .map(({ block, raw }) => [block.id, raw.manualLength]),
    ),
    partHeadingBlockIds: new Set(
      labelled
        .filter(({ position }) => partHeadings.has(position))
        .map(({ block }) => block.id),
    ),
  };
};
