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

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";

import type { ValidationSubject } from "@/api/lib/legal-search/parsers/validate-ast";
import { logger } from "@/api/lib/observability/logger";

import { normalizeInlineLine, stripInlineLinePrefix } from "./shared-inlines";

/** The three ways Czech and Slovak courts print a paragraph number. */
export const COURT_PARAGRAPH_MARKER_STYLES = [
  "bracket",
  "dot",
  "paren",
] as const;

export type CourtParagraphMarkerStyle =
  (typeof COURT_PARAGRAPH_MARKER_STYLES)[number];

/**
 * A marker is the number, its punctuation, then horizontal space. The space
 * is required for `12.` and `12)`: without it the shape is an amount, a date
 * or a section reference. A digit right after the space is a date
 * (`12. 3. 2020`), never a paragraph.
 */
const MARKER_PATTERNS = {
  bracket: /^\[(?<number>\d{1,4})\][ \t ]*(?!\d)/u,
  dot: /^(?<number>\d{1,4})\.[ \t ]+(?!\d)/u,
  paren: /^(?<number>\d{1,4})\)[ \t ]+(?!\d)/u,
} as const satisfies Record<CourtParagraphMarkerStyle, RegExp>;

/** Preference when two styles explain the same number of paragraphs. */
const STYLE_PRIORITY: Readonly<Record<CourtParagraphMarkerStyle, number>> = {
  bracket: 0,
  dot: 1,
  paren: 2,
};

/**
 * Bounds of "monotonic-ish". A court occasionally skips a number or prints
 * one twice; the stated value is kept, because the number is what the court
 * published and what a citation names. Beyond these bounds the markers are
 * not numbering a reader can rely on.
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
  /** Irregular steps (skips, repeats) allowed: a base plus one per 20. */
  irregularBase: 2,
  irregularPer: 20,
  /**
   * Unnumbered body paragraphs before the first number: the introductory
   * sentence of the decision and a short lead-in. Numbering that starts deep
   * in the body is an enumeration inside it.
   */
  maxLeadIn: 4,
  /**
   * Share of the body paragraphs between the first and last number that the
   * numbering itself accounts for, nested lists aside. Below it the markers
   * are scattered items, not the reasoning's paragraphs.
   */
  minDensity: 0.4,
} as const;

/**
 * Why markers that were present were not read as the court's numbering.
 * A closed set: the outcome is reported, and an operator sweeps by code.
 */
export const COURT_PARAGRAPH_NUMBERING_DEFECTS = {
  /** Numbers that go backwards or jump too far for a numbering. */
  IRREGULAR_SEQUENCE: "irregular-sequence",
} as const;

export type CourtParagraphNumberingDefect =
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

type Body = {
  /** Block indexes of the body paragraphs, in document order. */
  readonly paragraphs: readonly number[];
  /** Body positions where a separate opinion begins. */
  readonly opinionStarts: ReadonlySet<number>;
};

/**
 * The body paragraphs, and where each separate opinion printed after the
 * decision begins: an opinion either counts from 1 again or carries on the
 * decision's numbering, and both read as one numbering.
 */
const bodyOf = (blocks: readonly Block[]): Body => {
  const paragraphs: number[] = [];
  const opinionStarts = new Set<number>();
  let headingSinceBody = false;
  let inDissent = false;
  for (const [index, block] of blocks.entries()) {
    if (block.type === "heading") {
      headingSinceBody = true;
      continue;
    }
    if (!isBodyParagraph(block)) {
      continue;
    }
    const dissent = block.role === "dissent";
    if (dissent && (!inDissent || headingSinceBody)) {
      opinionStarts.add(paragraphs.length);
    }
    inDissent = dissent;
    headingSinceBody = false;
    paragraphs.push(index);
  }
  return { paragraphs, opinionStarts };
};

/**
 * Whether the candidate that would continue the court's run is instead the
 * next item of a nested list: the court's own paragraph with the same
 * number follows before the court's next one does.
 */
const continuesNestedList = (
  candidates: readonly Candidate[],
  from: number,
  value: number,
): boolean => {
  for (const later of candidates.slice(from + 1)) {
    if (later.number === value) {
      return true;
    }
    if (later.number === value + 1) {
      return false;
    }
  }
  return false;
};

type Walk = {
  readonly accepted: Candidate[];
  readonly irregular: number;
  readonly firstIrregular: Candidate | null;
};

/**
 * Read a style's candidates as the court's run beside nested lists. A
 * nested list starts at 1 and counts up; a separate opinion may start the
 * run again at 1; anything else that does not continue the run is an
 * irregular step.
 */
const walk = (candidates: readonly Candidate[]): Walk => {
  const accepted: Candidate[] = [];
  let expected = 1;
  let nestedNext: number | null = null;
  let irregular = 0;
  let firstIrregular: Candidate | null = null;
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
    if (
      courtNext &&
      !(listNext && continuesNestedList(candidates, index, number))
    ) {
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
    irregular += 1;
    firstIrregular ??= candidate;
    if (jump >= 0 && jump <= COURT_PARAGRAPH_NUMBERING_LIMITS.maxJump) {
      // A repeated or skipped number, kept as the court printed it.
      accepted.push(candidate);
      expected = number + 1;
      nestedNext = null;
    }
  }
  return { accepted, irregular, firstIrregular };
};

const candidatesOf = (
  blocks: readonly Block[],
  body: Body,
  style: CourtParagraphMarkerStyle,
): Candidate[] =>
  body.paragraphs.flatMap((blockIndex, bodyIndex) => {
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
  block?.type === "paragraph" &&
  COURT_PARAGRAPH_MARKER_STYLES.some(
    (style) => markerNumber(style, block.plainText.trimStart()) !== null,
  );

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

  // Paragraphs between the first and last number that are neither numbered
  // nor items of a list: the reasoning's own text the numbering skips.
  const span = body.paragraphs
    .slice(first.bodyIndex, last.bodyIndex + 1)
    .filter((blockIndex) => !opensWithMarker(blocks[blockIndex])).length;
  const density = best.accepted.length / (best.accepted.length + span);
  if (first.bodyIndex > limits.maxLeadIn || density < limits.minDensity) {
    // Markers scattered through an unnumbered text: items, not numbering.
    return { type: "unnumbered" };
  }

  const allowedIrregular =
    limits.irregularBase +
    Math.floor(best.accepted.length / limits.irregularPer);
  if (best.irregular > allowedIrregular) {
    return {
      type: "rejected",
      defect: COURT_PARAGRAPH_NUMBERING_DEFECTS.IRREGULAR_SEQUENCE,
      detail: `${best.style}: ${String(best.irregular)} irregular steps in ${String(best.accepted.length)} numbered paragraphs${
        best.firstIrregular === null
          ? ""
          : `; first at ${String(best.firstIrregular.number)}`
      }`,
    };
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

/**
 * Log event emitted when a decision's paragraphs open with markers that do
 * not read as numbering. Reported at WARN: the text is whole and the markers
 * stay in it, but `#par=` links and the reader's gutter have no numbers for
 * this decision.
 */
export const PARAGRAPH_NUMBERING_REJECTED =
  "case_law.ingestion.paragraph_numbering_rejected";

/**
 * The blocks with the court's numbers moved into structure, reporting a
 * numbering that was present but implausible.
 */
export const courtParagraphNumbers = (
  blocks: readonly Block[],
  subject: ValidationSubject,
): Block[] => {
  const numbering = extractCourtParagraphNumbers(blocks);
  if (numbering.type === "rejected") {
    logger.warn(PARAGRAPH_NUMBERING_REJECTED, {
      parser: subject.parser,
      caseNumber: subject.caseNumber,
      ...(subject.url === undefined ? {} : { url: subject.url }),
      defect: numbering.defect,
      detail: numbering.detail,
    });
  }
  return numbering.blocks;
};
