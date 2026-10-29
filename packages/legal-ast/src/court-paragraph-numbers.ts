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
 * decision read as numbering within each opinion, with nested lists
 * restarting at 1 beside it. A marker that cannot be read confidently stays
 * text; it does not invalidate the labels on the other paragraphs.
 */

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import { closedQuotationParagraphStarts } from "./closed-quotation-paragraphs";
import type { Block, ParagraphBlock } from "./document-ast.js";
import { normalizeInlineLine, stripInlineLinePrefix } from "./inline-line.js";
import { separateOpinionHeadingTail } from "./separate-opinion-heading.js";

/** The three ways Czech and Slovak courts print a paragraph number. */
const COURT_PARAGRAPH_MARKER_STYLES = ["bracket", "dot", "paren"] as const;

type CourtParagraphMarkerStyle = (typeof COURT_PARAGRAPH_MARKER_STYLES)[number];

/** Dates and lowercase list points are excluded even after a glued marker. */
const MARKER_PATTERNS = {
  bracket: /^\[(?<number>\d{1,4})\][ \t ]*(?![ \t \d\p{Ll}])/u,
  dot: /^(?<number>\d{1,4})\.(?:[ \t ]+(?![ \t \d\p{Ll}])|(?=\p{Lu}))/u,
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
  const value = parseIntegerToken(raw, { sign: "unsigned" }).unwrap(
    "Court marker matches bounded decimal digits",
  );
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

export const COURT_PARAGRAPH_NUMBERING_LIMITS = {
  /**
   * Fewest numbered paragraphs that make a numbering. A bracketed `[1]` is
   * the court's marker on its own — nothing else in a Czech or Slovak
   * decision opens a paragraph with one, footnotes aside, and those are not
   * body paragraphs — so a one-paragraph order keeps its number. A lone `1.`
   * or `1)` is as likely the first item of a list.
   */
  minParagraphs: { bracket: 1, dot: 2, paren: 2 },
  /** Largest forward jump accepted without a consecutive pair as evidence. */
  maxJump: 3,
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

/** Local evidence never invalidates another paragraph's printed label. */
export type CourtParagraphNumberingEvidence =
  | {
      readonly type: "duplicate";
      readonly blockIndex: number;
      readonly number: number;
      readonly previousBlockIndex: number;
    }
  | {
      readonly type: "ocr";
      readonly blockIndex: number;
      readonly number: number;
      readonly marker: string;
    }
  | {
      readonly type: "unassigned";
      readonly blockIndex: number;
      readonly number: number;
    };

type ScopeStart =
  | { readonly type: "fresh-start"; readonly startingAt: 1 }
  | { readonly type: "continuation"; readonly startingAt: number };

export type CourtParagraphNumberingScope = {
  readonly type: ScopeStart["type"];
  readonly blockIndex: number;
};

export type CourtParagraphNumbering =
  | {
      readonly type: "numbered";
      readonly blocks: Block[];
      readonly numbered: number;
      readonly style: CourtParagraphMarkerStyle;
      readonly evidence: readonly CourtParagraphNumberingEvidence[];
      readonly scopes: readonly CourtParagraphNumberingScope[];
    }
  | { readonly type: "unnumbered"; readonly blocks: Block[] };

const OCR_DOT_MARKER =
  /^(?<number>[\dlI]{1,4})\.(?:[ \t ]+(?![ \t \d\p{Ll}])|(?=\p{Lu}))/u;

/** A body paragraph opening with a marker of the style being read. */
type Candidate = {
  /** Position among the document's body paragraphs. */
  readonly bodyIndex: number;
  /** Position in the document's blocks. */
  readonly blockIndex: number;
  readonly number: number;
  readonly source: "printed" | "ocr" | "structured";
  readonly marker: string;
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
  let opinionHeadingSinceBody = false;
  let inDissent = false;
  let inInstruction = false;
  for (const [index, block] of blocks.entries()) {
    if (block.type === "heading") {
      headingSinceBody = true;
      opinionHeadingSinceBody ||=
        separateOpinionHeadingTail(
          block.plainText.replace(/^\d+[.)]\s*/u, ""),
          1000,
        ) !== undefined;
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
    if (dissent && (!inDissent || opinionHeadingSinceBody)) {
      opinionStarts.add(paragraphs.length);
    }
    if (headingSinceBody) {
      sectionStarts.add(paragraphs.length);
    }
    inDissent = dissent;
    headingSinceBody = false;
    opinionHeadingSinceBody = false;
    paragraphs.push(index);
  }
  const quotedStarts = closedQuotationParagraphStarts(
    paragraphs.map((blockIndex) => blocks[blockIndex]?.plainText ?? ""),
    new Set([...sectionStarts, ...opinionStarts]),
  );
  return { paragraphs, opinionStarts, quotedStarts };
};

/**
 * Whose a number is when it both continues the court's run and the open
 * nested list. Past the list's own continuation (value + 1, value + 2, …):
 * a same or smaller non-initial number follows, so this one is the list's;
 * or a number that continues neither, and is not a new list's 1,
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
    if (later.number > 1 && later.number <= value) {
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
  /**
   * Markers of this style that are neither the court's paragraph nor
   * provably an item of a nested list: a step backwards, an isolated large
   * jump, or a number both readings could claim.
   */
  readonly unassigned: Candidate[];
};

/**
 * Read a style's candidates as the court's run beside nested lists. A
 * nested list starts at 1 after a court paragraph and counts up; a separate
 * opinion may start the run again at 1; a forward skip of a few numbers is
 * the court's own. Quoted markers are excluded before this walk. Everything
 * else is left unassigned without invalidating the other labels.
 */
const walk = (candidates: readonly Candidate[], startingAt: number): Walk => {
  const accepted: Candidate[] = [];
  const unassigned: Candidate[] = [];
  let expected = startingAt;
  let nestedNext: number | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const { number } = candidate;
    if (accepted.length === 0 && number === 1) {
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
        // Both readings remain possible. Advance the court frontier as well
        // as the list frontier so a later list cannot steal this same label.
        expected = number + 1;
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
    // A repeat above 1 cannot start a nested list. Keep what was printed;
    // the next expected number is unchanged.
    if (
      nestedNext === null &&
      number > 1 &&
      number === accepted.at(-1)?.number
    ) {
      accepted.push(candidate);
      continue;
    }
    if (listNext || (number === 1 && accepted.length > 0)) {
      nestedNext = number + 1;
      continue;
    }
    // Before the first number, `last` is 0: a run the parser picked up at 2
    // (its paragraph 1 merged into the preamble) still reads as numbering.
    const last = accepted.at(-1)?.number ?? startingAt - 1;
    const jump = number - last;
    const next = candidates[index + 1];
    const continuationStart = expected;
    const continuationEnd = last + COURT_PARAGRAPH_NUMBERING_LIMITS.maxJump;
    // A pair inside a cited passage must not displace the court's run when
    // the next paragraph later resumes that run, even without quotation marks.
    const resumesAfterGap =
      jump > COURT_PARAGRAPH_NUMBERING_LIMITS.maxJump &&
      nestedNext === null &&
      next?.number === number + 1 &&
      next.bodyIndex === candidate.bodyIndex + 1 &&
      !candidates
        .slice(index + 2)
        .some(
          (later) =>
            later.number >= continuationStart &&
            later.number <= continuationEnd,
        );
    if (
      jump > 1 &&
      (jump <= COURT_PARAGRAPH_NUMBERING_LIMITS.maxJump || resumesAfterGap)
    ) {
      accepted.push(candidate);
      expected = number + 1;
      nestedNext = null;
      continue;
    }
    unassigned.push(candidate);
  }
  return { accepted, unassigned };
};

type Scope = { readonly from: number; readonly to: number };

const candidatesOf = (
  blocks: readonly Block[],
  body: Body,
  style: CourtParagraphMarkerStyle,
  { from, to }: Scope,
): Candidate[] =>
  body.paragraphs.slice(from, to).flatMap((blockIndex, position) => {
    const bodyIndex = from + position;
    if (body.quotedStarts.has(bodyIndex)) {
      return [];
    }
    const block = blocks[blockIndex];
    if (block?.type !== "paragraph") {
      return [];
    }
    const text = block.plainText.trimStart();
    const printed = markerNumber(style, text);
    let number = printed;
    let source: Candidate["source"] = "printed";
    let marker = "";
    if (number === null && style === "dot") {
      const raw = OCR_DOT_MARKER.exec(text)?.groups?.["number"];
      if (raw === undefined || !/[lI]/u.test(raw)) {
        return [];
      }
      const recovered = parseIntegerToken(raw.replace(/[lI]/gu, "1"), {
        sign: "unsigned",
      }).unwrap("OCR court marker normalizes to bounded decimal digits");
      const neighbourNumber = (index: number): number | null => {
        const neighbourIndex = body.paragraphs[index];
        const neighbour =
          neighbourIndex === undefined ? undefined : blocks[neighbourIndex];
        return neighbour?.type === "paragraph" && !body.quotedStarts.has(index)
          ? (neighbour.number ??
              markerNumber(style, neighbour.plainText.trimStart()))
          : null;
      };
      // Scope start supplies the zero before paragraph 1. Else both immediate
      // neighbours must print the consecutive values; OCR never repairs itself.
      const previous = position === 0 ? 0 : neighbourNumber(bodyIndex - 1);
      const next = bodyIndex + 1 < to ? neighbourNumber(bodyIndex + 1) : null;
      if (previous !== recovered - 1 || next !== recovered + 1) {
        return [];
      }
      number = recovered;
      source = "ocr";
      marker = raw;
    }
    return number === null
      ? []
      : [{ bodyIndex, blockIndex, number, source, marker }];
  });

/** Whether a body paragraph opens with any marker shape at all. */
const opensWithMarker = (block: Block | undefined): boolean =>
  block?.type === "paragraph" && LIST_ITEM_RE.test(block.plainText.trimStart());

type NumberAssignment = {
  readonly candidate: Candidate;
  readonly style: CourtParagraphMarkerStyle;
};

type Reading = {
  readonly numbers: ReadonlyMap<number, NumberAssignment>;
  readonly style: CourtParagraphMarkerStyle;
  readonly evidence: readonly CourtParagraphNumberingEvidence[];
  readonly scopes: readonly CourtParagraphNumberingScope[];
};

type BridgeScopeOptions = {
  readonly blocks: readonly Block[];
  readonly body: Body;
  readonly numbers: Map<number, NumberAssignment>;
  readonly evidence: CourtParagraphNumberingEvidence[];
  readonly from: number;
  readonly to: number;
};

/** Local proofs also apply when an upstream parser already supplied labels. */
const bridgeScope = ({
  blocks,
  body,
  numbers,
  evidence,
  from,
  to,
}: BridgeScopeOptions): void => {
  for (let bodyIndex = from + 1; bodyIndex + 1 < to; bodyIndex += 1) {
    const blockIndex = body.paragraphs[bodyIndex];
    const previousIndex = body.paragraphs[bodyIndex - 1];
    const nextIndex = body.paragraphs[bodyIndex + 1];
    if (
      blockIndex === undefined ||
      previousIndex === undefined ||
      nextIndex === undefined ||
      numbers.has(blockIndex) ||
      body.quotedStarts.has(bodyIndex)
    ) {
      continue;
    }
    const previous = numbers.get(previousIndex)?.candidate.number;
    const next = numbers.get(nextIndex)?.candidate.number;
    const block = blocks[blockIndex];
    if (
      previous === undefined ||
      next !== previous + 2 ||
      block?.type !== "paragraph"
    ) {
      continue;
    }
    for (const markerStyle of COURT_PARAGRAPH_MARKER_STYLES) {
      const text = block.plainText.trimStart();
      const raw =
        markerStyle === "dot"
          ? OCR_DOT_MARKER.exec(text)?.groups?.["number"]
          : undefined;
      const recovered = raw !== undefined && /[lI]/u.test(raw);
      const number = recovered
        ? parseIntegerToken(raw.replace(/[lI]/gu, "1"), {
            sign: "unsigned",
          }).unwrap("OCR court marker normalizes to bounded decimal digits")
        : markerNumber(markerStyle, text);
      if (number !== previous + 1) {
        continue;
      }
      numbers.set(blockIndex, {
        style: markerStyle,
        candidate: {
          blockIndex,
          bodyIndex,
          number,
          source: recovered ? "ocr" : "printed",
          marker: raw ?? "",
        },
      });
      if (recovered) {
        evidence.push({ type: "ocr", blockIndex, number, marker: raw });
      }
      break;
    }
  }
};

const readNumbering = (blocks: readonly Block[]): Reading => {
  const limits = COURT_PARAGRAPH_NUMBERING_LIMITS;
  const body = bodyOf(blocks);
  const numbers = new Map<number, NumberAssignment>();
  const evidence: CourtParagraphNumberingEvidence[] = [];
  const scopes: CourtParagraphNumberingScope[] = [];
  const starts = [...new Set([0, ...body.opinionStarts])].toSorted(
    (left, right) => left - right,
  );
  let style: CourtParagraphMarkerStyle = "bracket";
  let previousScopeLast = 0;
  for (const [index, from] of starts.entries()) {
    const to = starts[index + 1] ?? body.paragraphs.length;
    // Keep existing numbers as anchors. Raw markers in this scope need the
    // local bridge below; replay must not reinterpret an entire nested list.
    const firstStructuredIndex = body.paragraphs
      .slice(from, to)
      .find((blockIndex) => {
        const block = blocks[blockIndex];
        return block?.type === "paragraph" && block.number !== undefined;
      });
    if (firstStructuredIndex !== undefined) {
      const previousLast = previousScopeLast;
      for (const [position, blockIndex] of body.paragraphs
        .slice(from, to)
        .entries()) {
        const block = blocks[blockIndex];
        if (block?.type === "paragraph" && block.number !== undefined) {
          if (blockIndex === firstStructuredIndex) {
            scopes.push({
              type:
                previousLast > 0 && block.number === previousLast + 1
                  ? "continuation"
                  : "fresh-start",
              blockIndex,
            });
          }
          previousScopeLast = block.number;
          numbers.set(blockIndex, {
            style,
            candidate: {
              bodyIndex: from + position,
              blockIndex,
              number: block.number,
              source: "structured",
              marker: "",
            },
          });
        }
      }
      continue;
    }
    const freshStart = {
      type: "fresh-start",
      startingAt: 1,
    } as const satisfies ScopeStart;
    const scopeStarts =
      previousScopeLast === 0
        ? [freshStart]
        : [
            freshStart,
            {
              type: "continuation",
              startingAt: previousScopeLast + 1,
            } as const satisfies ScopeStart,
          ];
    // Compare the evidence within this opinion. A fresh run may start at 2
    // when paragraph 1 merged into its preamble; the preceding opinion must
    // not make those markers look like steps backwards.
    const best = COURT_PARAGRAPH_MARKER_STYLES.flatMap((candidateStyle) => {
      const candidates = candidatesOf(blocks, body, candidateStyle, {
        from,
        to,
      });
      return scopeStarts.map((start) => {
        const reading = walk(candidates, start.startingAt);
        let startPriority = 1;
        if (start.type === "continuation") {
          startPriority =
            reading.accepted.at(0)?.number === start.startingAt ? 0 : 2;
        }
        return {
          style: candidateStyle,
          start,
          ...reading,
          startPriority,
        };
      });
    })
      .toSorted(
        (left, right) =>
          right.accepted.length - left.accepted.length ||
          STYLE_PRIORITY[left.style] - STYLE_PRIORITY[right.style] ||
          left.startPriority - right.startPriority,
      )
      .at(0);
    const first = best?.accepted.at(0);
    if (
      best === undefined ||
      first === undefined ||
      best.accepted.length < limits.minParagraphs[best.style]
    ) {
      continue;
    }
    const span = body.paragraphs
      .slice(first.bodyIndex, to)
      .filter(
        (blockIndex) =>
          !opensWithMarker(blocks[blockIndex]) && !numbers.has(blockIndex),
      ).length;
    const density = best.accepted.length / (best.accepted.length + span);
    if (
      first.bodyIndex - from > limits.maxLeadIn ||
      density < limits.minDensity
    ) {
      continue;
    }
    style = best.style;
    scopes.push({ type: best.start.type, blockIndex: first.blockIndex });
    previousScopeLast = best.accepted.at(-1)?.number ?? previousScopeLast;
    const seen = new Map<number, number>();
    for (const candidate of best.accepted) {
      numbers.set(candidate.blockIndex, { candidate, style: best.style });
      const previousBlockIndex = seen.get(candidate.number);
      if (previousBlockIndex !== undefined) {
        evidence.push({
          type: "duplicate",
          blockIndex: candidate.blockIndex,
          number: candidate.number,
          previousBlockIndex,
        });
      }
      seen.set(candidate.number, candidate.blockIndex);
      if (candidate.source === "ocr") {
        evidence.push({
          type: "ocr",
          blockIndex: candidate.blockIndex,
          number: candidate.number,
          marker: candidate.marker,
        });
      }
    }
    for (const candidate of best.unassigned) {
      evidence.push({
        type: "unassigned",
        blockIndex: candidate.blockIndex,
        number: candidate.number,
      });
    }
  }
  for (const [scopeIndex, from] of starts.entries()) {
    const to = starts[scopeIndex + 1] ?? body.paragraphs.length;
    bridgeScope({ blocks, body, numbers, evidence, from, to });
  }
  return { numbers, style, evidence, scopes };
};

const withNumber = (
  block: ParagraphBlock,
  { style, candidate }: NumberAssignment,
): ParagraphBlock => {
  if (candidate.source === "structured") {
    return block;
  }
  const { line } = stripInlineLinePrefix(
    normalizeInlineLine(block.inlines),
    candidate.source === "ocr" ? OCR_DOT_MARKER : MARKER_PATTERNS[style],
  );
  return {
    ...block,
    number: candidate.number,
    inlines: line.inlines,
    plainText: line.plainText,
  };
};

/** Move each scope's proven printed labels without discarding other labels. */
export const extractCourtParagraphNumbers = (
  blocks: readonly Block[],
): CourtParagraphNumbering => {
  const reading = readNumbering(blocks);
  if (reading.numbers.size === 0) {
    return { type: "unnumbered", blocks: [...blocks] };
  }
  return {
    type: "numbered",
    blocks: blocks.map((block, index) => {
      const assignment = reading.numbers.get(index);
      return assignment === undefined || block.type !== "paragraph"
        ? block
        : withNumber(block, assignment);
    }),
    numbered: reading.numbers.size,
    style: reading.style,
    evidence: reading.evidence,
    scopes: reading.scopes,
  };
};
