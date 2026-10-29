/**
 * The court's own paragraph numbers, read off the start of its paragraphs.
 *
 * Czech and Slovak courts number the paragraphs of a decision's reasoning
 * and cite them ("bod 12", `#par=12`). The number arrives as text at the start
 * of the paragraph — `[12]`, `12.` or `12)` — and is moved into
 * `ParagraphBlock.number`, the place every consumer reads it from (the
 * reader's gutter, paragraph-range links, citations). The text keeps every
 * other character the court wrote.
 *
 * The same shapes also open things that are not the court's numbering: a
 * list of questions inside paragraph 3 (`1)`, `2)`), a heading-like item of
 * an older unnumbered decision (`1.`), a paragraph opening with a date
 * (`12. 3. 2020 …`). So a number is moved only when the paragraphs of a
 * decision read as numbering: one marker style, counting from 1 across the
 * body, with nested lists restarting at 1 beside it. A decision whose markers
 * do not read that way keeps them as text, which is faithful and reports the
 * outcome rather than storing a guess.
 */

import { panic } from "better-result";

import type { Block, ParagraphBlock } from "./document-ast.js";
import { normalizeInlineLine, stripInlineLinePrefix } from "./inline-line.js";

/** The three ways Czech and Slovak courts print a paragraph number. */
const COURT_PARAGRAPH_MARKER_STYLES = ["bracket", "dot", "paren"] as const;

type CourtParagraphMarkerStyle = (typeof COURT_PARAGRAPH_MARKER_STYLES)[number];

/**
 * A marker is the number, its punctuation, then horizontal space. The space
 * is required for `12.` and `12)`: without it the shape is an amount, a date
 * or a section reference. A digit right after the space is a date
 * (`12. 3. 2020`), never a paragraph; a lowercase letter is an item of a
 * list or of a quoted provision ("2. osoby fysické …"), because a court's
 * paragraph opens a sentence. The look-ahead also refuses more space, so it
 * judges the character after the whole run: backtracking into a run of two
 * spaces must not let "12.  3. 2020" through.
 */
const MARKER_PATTERNS = {
  bracket: /^\[(?<number>\d{1,4})\][ \t ]*(?![ \t \d\p{Ll}])/u,
  dot: /^(?<number>\d{1,4})\.[ \t ]+(?![ \t \d\p{Ll}])/u,
  paren: /^(?<number>\d{1,4})\)[ \t ]+(?![ \t \d\p{Ll}])/u,
} as const satisfies Record<CourtParagraphMarkerStyle, RegExp>;

const markerNumber = (
  style: CourtParagraphMarkerStyle,
  text: string,
): number | null => {
  const raw = MARKER_PATTERNS[style].exec(text)?.groups?.["number"];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return value >= 1 ? value : null;
};

/**
 * Whether a line opens with a marker in any of the court's paragraph styles.
 * A parser that assigns roles line by line asks this first: a line the court
 * numbered is body text, never a closing or a signature, even when its words
 * read like one ("3. Věc projednala samosoudkyně …"). Leaving it in the body
 * keeps the decision's numbering whole.
 */
export const opensWithCourtParagraphMarker = (text: string): boolean => {
  const line = text.trimStart();
  return COURT_PARAGRAPH_MARKER_STYLES.some(
    (style) => markerNumber(style, line) !== null,
  );
};

/**
 * Any item marker, whatever follows it: a court marker, a list's lowercase
 * point ("2. osoby …"), a lettered point ("a) …"). An item is not text the
 * numbering leaves out.
 */
const LIST_ITEM_RE = /^(?:\[\d{1,4}\]|\d{1,4}[.)]|\p{L}\)|[-–•])[ \t ]/u;

/** The instruction on remedies, which closes a decision's reasoning. */
const INSTRUCTION_RE = /^\s*P\s*o\s*u\s*[čc]\s*e\s*n\s*(?:[íi]|i\s*e)\s*:/iu;

/** Preference when two styles explain the same number of paragraphs. */
const STYLE_PRIORITY: Readonly<Record<CourtParagraphMarkerStyle, number>> = {
  bracket: 0,
  dot: 1,
  paren: 2,
};

/**
 * Bounds of a numbering. A court occasionally skips a number forward; the
 * stated value is kept, because the number is what the court published and
 * what a citation names. Two things are never allowed, whatever the count:
 * a number that does not rise (a repeat, or one going backwards), and a
 * marker of the numbering's style left unassigned that is not provably an
 * item of a nested list. Either means a reader could not tell which
 * paragraph a number names, and the whole decision keeps its markers as
 * text.
 */
export const COURT_PARAGRAPH_NUMBERING_LIMITS = {
  /**
   * Fewest numbered paragraphs that make a numbering. A bracketed `[1]` is
   * the court's marker on its own — nothing else in a Czech or Slovak
   * decision opens a paragraph with one, footnotes aside, and those are not
   * body paragraphs — so a one-paragraph order keeps its number. A lone `1.`
   * or `1)` is as likely the first item of a list.
   */
  minParagraphs: { bracket: 1, dot: 2, paren: 2 },
  /** Largest forward jump: 4 → 6 skips one number. */
  maxJump: 3,
  /** Forward skips allowed: a base plus one per 20 numbered paragraphs. */
  irregularBase: 2,
  irregularPer: 20,
  /**
   * Unnumbered body paragraphs before the first number: the introductory
   * sentence of the decision and a short lead-in. Numbering that starts deep
   * in the body is an enumeration inside it.
   */
  maxLeadIn: 4,
  /**
   * Share of the body paragraphs from the first number to the end of its
   * part that the numbering itself accounts for, nested lists aside. Below
   * it the markers are scattered or leading items, not the reasoning's
   * paragraphs.
   */
  minDensity: 0.4,
} as const;

/**
 * Why markers that were present were not read as the court's numbering.
 * A closed set: the outcome is reported, and an operator sweeps by code.
 */
export const COURT_PARAGRAPH_NUMBERING_DEFECTS = {
  /**
   * Numbers that repeat, go backwards or jump too far, or a marker of the
   * numbering's style that no reading assigns unambiguously.
   */
  IRREGULAR_SEQUENCE: "irregular-sequence",
} as const;

type CourtParagraphNumberingDefect =
  (typeof COURT_PARAGRAPH_NUMBERING_DEFECTS)[keyof typeof COURT_PARAGRAPH_NUMBERING_DEFECTS];

export type CourtParagraphNumbering =
  | {
      readonly type: "numbered";
      readonly blocks: Block[];
      /** Paragraphs that now carry a number. */
      readonly numbered: number;
      readonly style: CourtParagraphMarkerStyle;
    }
  | { readonly type: "unnumbered"; readonly blocks: Block[] }
  | {
      readonly type: "rejected";
      readonly blocks: Block[];
      readonly defect: CourtParagraphNumberingDefect;
      readonly detail: string;
    };

/** A body paragraph opening with a marker of the style being read. */
type Candidate = {
  /** Position among the document's body paragraphs. */
  readonly bodyIndex: number;
  /** Position in the document's blocks. */
  readonly blockIndex: number;
  readonly number: number;
  /** The first paragraph of a separate opinion, which may count from 1. */
  readonly opensOpinion: boolean;
};

/**
 * The paragraphs that can carry the court's number: body text in the
 * court's own voice. Holdings, headings, captions, closings, signatures,
 * notes and publisher apparatus never do.
 */
const NUMBERABLE_ROLES = new Set<ParagraphBlock["role"]>([
  undefined,
  "argumentation",
  "history",
  "dissent",
]);

const isBodyParagraph = (block: Block): block is ParagraphBlock =>
  block.type === "paragraph" &&
  block.note === undefined &&
  NUMBERABLE_ROLES.has(block.role);

type Body = {
  /** Block indexes of the body paragraphs, in document order. */
  readonly paragraphs: readonly number[];
  /** Body positions where a separate opinion begins. */
  readonly opinionStarts: ReadonlySet<number>;
  /** Body positions inside a closed quotation begun before them. */
  readonly quotedStarts: ReadonlySet<number>;
};

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

/** Quotations of each pair a paragraph leaves open, from those it opens at. */
const openQuotesAfter = (open: readonly number[], text: string): number[] => {
  const states = QUOTE_PAIRS.map(({ opening, closing }, pair) => ({
    opening,
    closing,
    count: open[pair] ?? 0,
  }));
  for (const character of text) {
    const closing = states.find(
      (state) => state.count > 0 && state.closing.has(character),
    );
    if (closing !== undefined) {
      closing.count -= 1;
      continue;
    }
    // The closing guillemet cannot also open the opposite quotation direction.
    const opening = states.find((state) => state.opening === character);
    if (opening !== undefined) {
      opening.count += 1;
    }
  }
  return states.map(({ count }) => count);
};

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
const quotedStartsOf = (
  texts: readonly string[],
  sectionStarts: ReadonlySet<number>,
): Set<number> => {
  const quoted = new Set<number>();
  for (let start = 0; start < texts.length; start++) {
    let open = openQuotesAfter([], texts[start] ?? "");
    for (
      let end = start + 1;
      open.some((count) => count > 0) &&
      end < texts.length &&
      end - start <= MAX_QUOTED_PARAGRAPHS &&
      !sectionStarts.has(end);
      end++
    ) {
      open = openQuotesAfter(open, texts[end] ?? "");
      if (open.every((count) => count === 0)) {
        for (let inside = start + 1; inside <= end; inside++) {
          quoted.add(inside);
        }
        start = end - 1;
        break;
      }
    }
  }
  return quoted;
};

/**
 * The body paragraphs, and where each separate opinion printed after the
 * decision begins: an opinion either counts from 1 again or carries on the
 * decision's numbering, and both read as one numbering.
 */
const bodyOf = (blocks: readonly Block[]): Body => {
  const paragraphs: number[] = [];
  const opinionStarts = new Set<number>();
  /** Body positions a heading or a separate opinion opens. */
  const sectionStarts = new Set<number>();
  let headingSinceBody = false;
  let inDissent = false;
  let inInstruction = false;
  for (const [index, block] of blocks.entries()) {
    if (block.type === "heading") {
      headingSinceBody = true;
      inInstruction ||= INSTRUCTION_RE.test(block.plainText);
      continue;
    }
    if (!isBodyParagraph(block)) {
      continue;
    }
    const dissent = block.role === "dissent";
    // The instruction on remedies ("Poučení: …") and what follows it up to a
    // separate opinion is not reasoning: never numbered, and not text the
    // numbering leaves out.
    if (INSTRUCTION_RE.test(block.plainText)) {
      inInstruction = true;
    }
    if (inInstruction && !dissent) {
      continue;
    }
    inInstruction = false;
    if (dissent && (!inDissent || headingSinceBody)) {
      opinionStarts.add(paragraphs.length);
    }
    if (headingSinceBody) {
      sectionStarts.add(paragraphs.length);
    }
    inDissent = dissent;
    headingSinceBody = false;
    paragraphs.push(index);
  }
  const quotedStarts = quotedStartsOf(
    paragraphs.map((blockIndex) => blocks[blockIndex]?.plainText ?? ""),
    new Set([...sectionStarts, ...opinionStarts]),
  );
  return { paragraphs, opinionStarts, quotedStarts };
};

/**
 * Whose a number is when it both continues the court's run and the open
 * nested list. Past the list's own continuation (value + 1, value + 2, …):
 * the court's paragraph with this very number follows, so this one is the
 * list's; or a number that continues neither, and is not a new list's 1,
 * breaks the list off, so this one is the court's. A new list's 1 proves
 * nothing — it may follow the list or the court's paragraph — and reaching
 * the end with only the continuation seen leaves both readings standing:
 * neither may be stored.
 */
const readContinuation = (
  candidates: readonly Candidate[],
  from: number,
  value: number,
): "list" | "court" | "ambiguous" => {
  let listNext = value + 1;
  for (const later of candidates.slice(from + 1)) {
    if (later.number === value) {
      return "list";
    }
    if (later.number !== listNext) {
      return later.number === 1 ? "ambiguous" : "court";
    }
    listNext += 1;
  }
  return "ambiguous";
};

type Walk = {
  /** The court's paragraphs, in order. */
  readonly accepted: Candidate[];
  /** Forward skips the court made (4 → 6), kept as printed. */
  readonly skips: number;
  /**
   * Markers of this style that are neither the court's paragraph nor
   * provably an item of a nested list: a repeat, a step backwards, a jump
   * too far, or a number both readings could claim.
   */
  readonly unassigned: Candidate[];
};

/**
 * Read a style's candidates as the court's run beside nested lists. A
 * nested list starts at 1 after a court paragraph and counts up; a separate
 * opinion may start the run again at 1; a forward skip of a few numbers is
 * the court's own. Quoted markers are excluded before this walk. Everything
 * else is left unassigned, and an unassigned marker rejects the reading.
 */
const walk = (candidates: readonly Candidate[]): Walk => {
  const accepted: Candidate[] = [];
  const unassigned: Candidate[] = [];
  let expected = 1;
  let nestedNext: number | null = null;
  let skips = 0;
  for (const [index, candidate] of candidates.entries()) {
    const { number } = candidate;
    if (candidate.opensOpinion && number === 1) {
      accepted.push(candidate);
      expected = 2;
      nestedNext = null;
      continue;
    }
    const courtNext = number === expected;
    const listNext = nestedNext !== null && number === nestedNext;
    if (courtNext && listNext) {
      const reading = readContinuation(candidates, index, number);
      if (reading === "ambiguous") {
        unassigned.push(candidate);
        nestedNext = number + 1;
        continue;
      }
      if (reading === "list") {
        nestedNext = number + 1;
        continue;
      }
    }
    if (courtNext) {
      accepted.push(candidate);
      expected = number + 1;
      nestedNext = null;
      continue;
    }
    if (listNext || (number === 1 && accepted.length > 0)) {
      nestedNext = number + 1;
      continue;
    }
    // Before the first number, `last` is 0: a run the parser picked up at 2
    // (its paragraph 1 merged into the preamble) still reads as numbering.
    const last = accepted.at(-1)?.number ?? 0;
    const jump = number - last;
    if (jump > 1 && jump <= COURT_PARAGRAPH_NUMBERING_LIMITS.maxJump) {
      accepted.push(candidate);
      skips += 1;
      expected = number + 1;
      nestedNext = null;
      continue;
    }
    unassigned.push(candidate);
  }
  return { accepted, skips, unassigned };
};

/**
 * The court's paragraphs strictly rise, starting again at 1 only where a
 * separate opinion begins.
 */
const strictlyRising = (accepted: readonly Candidate[]): boolean => {
  let previous = 0;
  for (const { number, opensOpinion } of accepted) {
    if (opensOpinion && number === 1) {
      previous = 1;
      continue;
    }
    if (number <= previous) {
      return false;
    }
    previous = number;
  }
  return true;
};

const candidatesOf = (
  blocks: readonly Block[],
  body: Body,
  style: CourtParagraphMarkerStyle,
): Candidate[] =>
  body.paragraphs.flatMap((blockIndex, bodyIndex) => {
    // A closed quotation's markers cannot advance either the court's run
    // or a nested list, including when lookahead examines them.
    if (body.quotedStarts.has(bodyIndex)) {
      return [];
    }
    const block = blocks[blockIndex];
    const number =
      block?.type === "paragraph"
        ? markerNumber(style, block.plainText.trimStart())
        : null;
    return number === null
      ? []
      : [
          {
            bodyIndex,
            blockIndex,
            number,
            opensOpinion: body.opinionStarts.has(bodyIndex),
          },
        ];
  });

/** Whether a body paragraph opens with any marker shape at all. */
const opensWithMarker = (block: Block | undefined): boolean =>
  block?.type === "paragraph" && LIST_ITEM_RE.test(block.plainText.trimStart());

type Reading =
  | {
      readonly type: "numbered";
      readonly style: CourtParagraphMarkerStyle;
      readonly numbers: ReadonlyMap<number, number>;
    }
  | { readonly type: "unnumbered" }
  | {
      readonly type: "rejected";
      readonly defect: CourtParagraphNumberingDefect;
      readonly detail: string;
    };

const readNumbering = (blocks: readonly Block[]): Reading => {
  const limits = COURT_PARAGRAPH_NUMBERING_LIMITS;
  const body = bodyOf(blocks);
  if (
    body.paragraphs.some((blockIndex) => {
      const block = blocks[blockIndex];
      return block?.type === "paragraph" && block.number !== undefined;
    })
  ) {
    // Already numbered — by the source's own structure or an earlier pass.
    // What still opens with a marker is a list inside the numbering.
    return { type: "unnumbered" };
  }
  const best = COURT_PARAGRAPH_MARKER_STYLES.map((style) => ({
    style,
    candidates: candidatesOf(blocks, body, style),
  }))
    .filter(({ candidates }) => candidates.length > 0)
    .map(({ style, candidates }) => ({ style, ...walk(candidates) }))
    .toSorted(
      (left, right) =>
        right.accepted.length - left.accepted.length ||
        STYLE_PRIORITY[left.style] - STYLE_PRIORITY[right.style],
    )
    .at(0);
  const first = best?.accepted.at(0);
  const last = best?.accepted.at(-1);
  if (
    best === undefined ||
    first === undefined ||
    last === undefined ||
    best.accepted.length < limits.minParagraphs[best.style]
  ) {
    return { type: "unnumbered" };
  }

  // Paragraphs from the first number to the end of its part of the decision
  // (the next separate opinion, or the end) that are neither numbered nor
  // items of a list: the text the numbering would leave unnumbered. A
  // court's numbering runs to the end of its reasoning; a two-item list
  // followed by unnumbered paragraphs is a list.
  const partEnd =
    [...body.opinionStarts]
      .filter((start) => start > last.bodyIndex)
      .toSorted((left, right) => left - right)
      .at(0) ?? body.paragraphs.length;
  const span = body.paragraphs
    .slice(first.bodyIndex, partEnd)
    .filter((blockIndex) => !opensWithMarker(blocks[blockIndex])).length;
  const density = best.accepted.length / (best.accepted.length + span);
  if (first.bodyIndex > limits.maxLeadIn || density < limits.minDensity) {
    // Markers scattered through an unnumbered text: items, not numbering.
    return { type: "unnumbered" };
  }

  const rejected = (detail: string): Reading => ({
    type: "rejected",
    defect: COURT_PARAGRAPH_NUMBERING_DEFECTS.IRREGULAR_SEQUENCE,
    detail: `${best.style}: ${detail}`,
  });
  // Hard invariants, with no allowance: every number rises, and every
  // marker of the style is either the court's or provably a list item.
  if (!strictlyRising(best.accepted)) {
    return rejected("the numbers do not strictly rise");
  }
  const stray = best.unassigned.at(0);
  if (stray !== undefined) {
    return rejected(
      `${String(best.unassigned.length)} markers no reading assigns; first at ${String(stray.number)}`,
    );
  }
  const allowedSkips =
    limits.irregularBase +
    Math.floor(best.accepted.length / limits.irregularPer);
  if (best.skips > allowedSkips) {
    return rejected(
      `${String(best.skips)} forward skips in ${String(best.accepted.length)} numbered paragraphs`,
    );
  }
  return {
    type: "numbered",
    style: best.style,
    numbers: new Map(
      best.accepted.map(({ blockIndex, number }) => [blockIndex, number]),
    ),
  };
};

const withNumber = (
  block: ParagraphBlock,
  style: CourtParagraphMarkerStyle,
  number: number,
): ParagraphBlock => {
  const { line } = stripInlineLinePrefix(
    normalizeInlineLine(block.inlines),
    MARKER_PATTERNS[style],
  );
  return {
    ...block,
    number,
    inlines: line.inlines,
    plainText: line.plainText,
  };
};

/**
 * Move the court's paragraph numbers from the text into `number`.
 *
 * The decision and its separate opinions are read as one numbering, so an
 * implausible one is rejected whole: a decision half of whose markers are
 * structured reads worse than one with all of them as printed.
 */
export const extractCourtParagraphNumbers = (
  blocks: readonly Block[],
): CourtParagraphNumbering => {
  const reading = readNumbering(blocks);
  switch (reading.type) {
    case "unnumbered":
      return { type: "unnumbered", blocks: [...blocks] };
    case "rejected":
      return {
        type: "rejected",
        blocks: [...blocks],
        defect: reading.defect,
        detail: reading.detail,
      };
    case "numbered":
      return {
        type: "numbered",
        blocks: blocks.map((block, index) => {
          const number = reading.numbers.get(index);
          return number === undefined || block.type !== "paragraph"
            ? block
            : withNumber(block, reading.style, number);
        }),
        numbered: reading.numbers.size,
        style: reading.style,
      };
    default: {
      reading satisfies never;
      return panic("Unhandled court paragraph numbering reading");
    }
  }
};
