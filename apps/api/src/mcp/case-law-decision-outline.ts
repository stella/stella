import { panic } from "better-result";

import { headingPathsByAnchor } from "@stll/legal-ast";
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
  let offset = 0;
  for (const block of blocks) {
    const found = text.indexOf(block.plainText, offset);
    if (block.plainText.length === 0 || found === -1) {
      continue;
    }
    offset = found + block.plainText.length;
    located.push({
      anchorId: block.anchorId,
      end: offset,
      start: found,
      text: block.plainText,
      type: block.type,
      headingPath: (
        paths.get(block.anchorId) ??
        panic("Every AST anchor has a heading path")
      ).map(({ title }) => title),
      label:
        block.type === "paragraph" && block.number !== undefined
          ? String(block.number)
          : printedParagraphLabel(block.plainText),
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
  /** Where the entry starts in the served plain text. */
  start: number;
  title: string;
};

type DecisionOutlineResult = {
  entries: DecisionOutlineEntry[];
  numberedEntriesTruncated: boolean;
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
  // AST headings always travel verbatim; numbered lines fill the remaining
  // navigation budget. Walk located spans once, in the same order as lines.
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
    if (entries.has(start) || enclosingBlock?.type === "heading") {
      continue;
    }
    if (entries.size >= OUTLINE_LIMIT) {
      numberedEntriesTruncated = true;
      continue;
    }
    entries.set(start, {
      anchorId: enclosingBlock?.anchorId ?? null,
      start,
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
