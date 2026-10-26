import { panic } from "better-result";

import { headingPathsByAnchor } from "@stll/legal-ast";
import { courtParagraphNumber } from "@stll/legal-ast/court-paragraph-number";
import type { Block } from "@stll/legal-ast/document-ast";

import { resolveTextWindowBounds } from "@/api/mcp/tool-utils";

const OUTLINE_LIMIT = 100;
// A navigation label, not a preview: a numbered paragraph is named by its
// opening words, and a hundred long openings would outweigh the page itself.
const TITLE_LIMIT = 80;
const NUMBERED_SECTION = /^(?:[IVXLCDM]+[.)]|\d+[.)]|\[\d+\])(?:\s|$)/u;

/** A block found in the served plain text, with where it sits there. */
export type LocatedDecisionBlock = {
  anchorId: string | null;
  number?: number | undefined;
  end: number;
  start: number;
  text: string;
  type: Block["type"];
  headingPath: string[];
  label: string | null;
};

export const printedParagraphLabel = (text: string): string | null => {
  const match = /^\s*(?:\[(\d+)\]|(\d+)\.)(?:\s|$)/u.exec(text);
  return match?.[1] ?? match?.[2] ?? null;
};

/** The paragraph numbers the parser recovered as structure. */
const courtNumbersOf = (blocks: readonly Block[]): ReadonlySet<string> =>
  new Set(
    blocks.flatMap((block) => {
      const number = courtParagraphNumber(block);
      return number === null ? [] : [String(number)];
    }),
  );

/**
 * A located block's label: the court's number where the parser recovered
 * one, else the number a paragraph prints at its start.
 *
 * A printed number that is also one of the court's structural numbers is
 * not a label: the figure opening a heading (`2. The provisional
 * nature…`), a quoted provision (`2. The adequacy of…`) or a list item
 * (`1) disciplinary proceedings:`) would otherwise name a second
 * "paragraph 2". A heading is never labelled as a paragraph.
 */
const blockLabel = ({
  block,
  number,
  courtNumbers,
}: {
  block: Block;
  number: number | null;
  courtNumbers: ReadonlySet<string>;
}): string | null => {
  if (number !== null) {
    return String(number);
  }
  const printed =
    block.type === "paragraph" ? printedParagraphLabel(block.plainText) : null;
  return printed === null || courtNumbers.has(String(Number(printed)))
    ? null
    : printed;
};

/**
 * Every block with text, located in the served plain text in document order.
 * The plain text is built from these blocks, so each is found after the one
 * before it; a block that cannot be found (a fallback text that differs) is
 * left out rather than guessed at.
 */
export const locateDecisionBlocks = (
  blocks: readonly Block[],
  text: string,
): LocatedDecisionBlock[] => {
  const located: LocatedDecisionBlock[] = [];
  const paths = headingPathsByAnchor(blocks);
  const courtNumbers = courtNumbersOf(blocks);
  let offset = 0;
  for (const block of blocks) {
    const found = text.indexOf(block.plainText, offset);
    if (block.plainText.length === 0 || found === -1) {
      continue;
    }
    offset = found + block.plainText.length;
    const number = courtParagraphNumber(block);
    located.push({
      anchorId: block.anchorId,
      ...(number === null ? {} : { number }),
      end: offset,
      start: found,
      text: block.plainText,
      type: block.type,
      headingPath: (
        paths.get(block.anchorId) ??
        panic("Every AST anchor has a heading path")
      ).map(({ title }) => title),
      label: blockLabel({ block, number, courtNumbers }),
    });
  }
  return located;
};

type DecisionOutlineOptions = {
  blocks: readonly Block[] | null;
  text: string;
};

type DecisionOutlineEntry = {
  /** The reader's fragment for the block the entry opens, when it has one. */
  anchorId: string | null;
  number?: number | undefined;
  /** Where the entry starts in the served plain text. */
  start: number;
  title: string;
};

type DecisionOutlineResult = {
  entries: DecisionOutlineEntry[];
  numberedEntriesTruncated: boolean;
};

/** A numbered passage the outline may name, in served-text order. */
type NumberedCandidate = {
  anchorId: string | null;
  number?: number | undefined;
  start: number;
  title: string;
};

/**
 * The court's numbered paragraphs, where the parser recovered the
 * numbering: each block that carries a number, titled by its opening words.
 */
const structuralNumberedCandidates = (
  located: readonly LocatedDecisionBlock[],
): NumberedCandidate[] =>
  located.flatMap((block) =>
    block.number === undefined
      ? []
      : [
          {
            anchorId: block.anchorId,
            number: block.number,
            start: block.start,
            title: block.text.split(/\r?\n/u, 1)[0]?.trim() ?? "",
          },
        ],
  );

/**
 * Lines of the served text that open with a section or paragraph marker,
 * where the parser recovered no numbering and the text is all there is. A
 * line inside a heading block is the heading's, which travels already.
 */
const printedNumberedCandidates = (
  located: readonly LocatedDecisionBlock[],
  text: string,
): NumberedCandidate[] => {
  const candidates: NumberedCandidate[] = [];
  let blockIndex = 0;
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    const title = line[0].trim();
    if (!NUMBERED_SECTION.test(title)) {
      continue;
    }
    const start = line.index + line[0].indexOf(title);
    let block = located.at(blockIndex);
    while (block !== undefined && block.end <= start) {
      blockIndex += 1;
      block = located.at(blockIndex);
    }
    const enclosingBlock =
      block !== undefined && block.start <= start ? block : undefined;
    if (enclosingBlock?.type === "heading") {
      continue;
    }
    candidates.push({
      anchorId: enclosingBlock?.anchorId ?? null,
      ...(enclosingBlock?.number === undefined
        ? {}
        : { number: enclosingBlock.number }),
      start,
      title,
    });
  }
  return candidates;
};

export const decisionOutline = ({
  blocks,
  text,
}: DecisionOutlineOptions): DecisionOutlineResult => {
  const located = blocks === null ? [] : locateDecisionBlocks(blocks, text);
  const entries = new Map<number, DecisionOutlineEntry>();
  let numberedEntriesTruncated = false;
  for (const block of located) {
    if (block.type === "heading") {
      entries.set(block.start, {
        anchorId: block.anchorId,
        start: block.start,
        title: block.text,
      });
    }
  }
  // AST headings always travel verbatim; numbered passages fill the
  // remaining navigation budget. Where the parser recovered the court's
  // numbering, the numbered passages are its paragraphs: a line that still
  // opens with a figure there is a quoted provision or a list item
  // (`2. The adequacy of…`, `1) disciplinary proceedings:`), not a section.
  const numbered =
    blocks !== null && courtNumbersOf(blocks).size > 0
      ? structuralNumberedCandidates(located)
      : printedNumberedCandidates(located, text);
  for (const { title, ...candidate } of numbered) {
    if (entries.has(candidate.start)) {
      continue;
    }
    if (entries.size >= OUTLINE_LIMIT) {
      numberedEntriesTruncated = true;
      continue;
    }
    entries.set(candidate.start, {
      ...candidate,
      title: title.slice(
        0,
        resolveTextWindowBounds({ text: title, offset: 0, size: TITLE_LIMIT })
          .end,
      ),
    });
  }
  return {
    entries: [...entries.values()].toSorted(
      (left, right) => left.start - right.start,
    ),
    numberedEntriesTruncated,
  };
};
